import { randomBytes } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import type { SidecarClientKind, SidecarEndpointFile, SidecarEventSubscriber, SidecarOpDefinition, SidecarTraceEvent } from '@jevris/contracts';
import { OWNED_MODE_OP, activeVerificationRuns, migrateModeDefault, ownedModeEnabled, setManagedPolicyDefaults } from '@jevris/orchestrator';
import { currentUser, ensurePrivateDir, jevrisPaths, writePrivateFile, type ExecPort } from '@jevris/platform';
import { pathLineWriter } from './line-writer.js';
import { execStatus, sidecarManagedOptions } from './managed-exec.js';
import { detectLocality } from './locality.js';
import { loadOps, type LoadedOps } from './ops.js';
import {
  CLIENT_KINDS,
  ENDPOINT_SCHEMA,
  FOREIGN_LOCALITY_MESSAGE,
  LOCALITY_REFRESH_MS,
  PROTOCOL,
  b64url,
  fallbackDirSafe,
  isNamedPipe,
  foreignSidecar,
  jevrisPackage,
  loadedRuntimeBuild,
  localityRecordText,
  pidAlive,
  randomPipeName,
  readEndpoint,
  runtimeBuild,
  runtimeFiles,
  scrubCredentialEnv,
  socketCandidates,
  type RuntimeBuild,
  type RuntimeFiles,
} from './protocol.js';
import { startService, type LogEntry, type ServiceLimits, type SidecarService } from './service.js';
import type { AdmissionLimits } from './admission.js';
import { openRuntimeState, type RuntimeState } from './state.js';

/**
 * The long-lived sidecar (IPC-11..IPC-14): one per user and Jevris home, guarded by an
 * exclusive lock file, recovering a stale socket or pidfile, with an owner-only JSONL log,
 * signal handlers, graceful drain and idle exit. The kill switch is read before every frame.
 */

export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** How often a running sidecar compares its build with the runtime installed on disk. */
export const BUILD_CHECK_MS = 30_000;
/**
 * The exit code of a supervised sidecar retired for a newer build of its runtime: not 0, so
 * launchd (KeepAlive SuccessfulExit false), systemd (Restart=on-failure) and Task Scheduler
 * start it again, now on the installed build. An unsupervised one exits 0.
 */
export const STALE_BUILD_EXIT_CODE = 75;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export interface DaemonOptions {
  readonly home?: string;
  /** Idle exit; 0 disables it. Default 30 minutes, or JEVRIS_SIDECAR_IDLE_MS. */
  readonly idleMs?: number;
  /**
   * Work that holds off the idle exit although no request is open (default: D's
   * activeVerificationRuns, the verification runs in this process; tests inject it). A run
   * can outlast the idle period (a 30-minute npm test), and an idle exit would cut it off.
   */
  readonly backgroundWork?: () => number;
  /**
   * The build this sidecar loaded and the build installed on disk now (defaults:
   * loadedRuntimeBuild and runtimeBuild from protocol.ts; tests inject them), compared every
   * `checkMs` (default BUILD_CHECK_MS).
   */
  readonly build?: { readonly loaded: () => RuntimeBuild | null; readonly onDisk: () => RuntimeBuild | null; readonly checkMs?: number };
  readonly supervised?: boolean;
  readonly platform?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Live certification evidence and re-checks (tests inject ports; false turns them off). */
  readonly liveCertification?: import('./live-certification.js').LiveCertificationPorts | false;
  /** The harness model-offer refresh ports (tests); absent: the product ports (off under a test run); false: off. */
  readonly modelOffer?: import('./model-offer.js').ModelOfferPorts | false;
  /** The model-offer idle quiet time and busy retry (tests shorten them). */
  readonly modelOfferIdleMs?: number;
  /** Access limits R76: the resume tick's period (tests shorten it); 0 turns it off. */
  readonly accessResumeMs?: number;
  /** Extra ops (tests); package ops are loaded from SIDECAR_OP_PACKAGES. */
  readonly ops?: readonly SidecarOpDefinition[];
  readonly subscribers?: readonly SidecarEventSubscriber[];
  /** Skip loading package ops (tests that pin the registry). */
  readonly packageOps?: boolean;
  readonly limits?: Partial<ServiceLimits>;
  /** Hot and background admission pools (audit P4; tests). */
  readonly admission?: Partial<AdmissionLimits>;
  /** Background executor concurrency and memory bound before the spool (tests). */
  readonly backgroundConcurrency?: number;
  readonly backgroundMemoryBytes?: number;
  /** P10: the script a store-maintenance worker runs (the sidecar entry). Absent: maintenance runs inline. */
  readonly maintenanceWorker?: string | URL;
  /** Tests only: the in-use owned-worker worktrees status lists links for (RuntimeStateInput). */
  readonly ownedWorktrees?: import('./state.js').RuntimeStateInput['ownedWorktrees'];
  /** Tests only: the route.host certification answer (RuntimeStateInput, serving hosts R50). */
  readonly hostRouteCertified?: import('./state.js').RuntimeStateInput['hostRouteCertified'];
  readonly log?: (entry: LogEntry) => void;
  /** Injected for the Windows pipe ACL step. */
  readonly exec?: ExecPort;
  /** Injected engine (tests); otherwise built once from @jevris/provider-typesafe. */
  readonly engine?: unknown;
  /** Open the store (default true). */
  readonly store?: boolean;
  readonly now?: () => number;
  /** Upper bound on one event subscriber's slice (default 250 ms; tests raise it). */
  readonly subscriberSliceMs?: number;
  /** The clock events are stamped and deduped with (tests); default Date.now. */
  readonly eventClock?: () => number;
}

export type DaemonStartResult =
  | { readonly ok: true; readonly daemon: SidecarDaemon }
  | {
      readonly ok: false;
      readonly reason: 'already-running' | 'foreign-locality' | 'runtime-dir' | 'no-socket-path' | 'listen-failed' | 'duplicate-op';
      readonly message: string;
    };

export interface SidecarDaemon {
  readonly service: SidecarService;
  readonly files: RuntimeFiles;
  readonly endpoint: SidecarEndpointFile;
  readonly state: RuntimeState;
  readonly pipeAcl: 'owner-only' | 'default' | 'not-applicable' | 'pending';
  /** Resolves when the daemon has fully stopped. */
  readonly stopped: Promise<string>;
  stop(reason: string): Promise<void>;
}

// ------------------------------------------------------------------ log (IPC-11)

/**
 * The sidecar log (IPC-11). P7: lines are queued and appended asynchronously on the next turn of
 * the event loop, rotated by a byte counter; `flushSync` writes the rest at shutdown. A full queue
 * or a full disk drops lines rather than take the sidecar down.
 */
export function createFileLog(path: string): ((entry: LogEntry) => void) & { flushSync(): void } {
  const writer = pathLineWriter(path, LOG_ROTATE_BYTES);
  const log = (entry: LogEntry): void => {
    try {
      writer.write(`${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
    } catch {
      // stderr is not attached when detached
    }
  };
  return Object.assign(log, { flushSync: () => writer.flushSync() });
}

// ------------------------------------------------------------------ locks and stale state

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string') return code;
  }
  return 'EUNKNOWN';
}

function lockHolder(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { readonly pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Lock files this process holds, so a second in-process start sees them as held. */
const heldLocks = new Set<string>();

/** Exclusive daemon lock: two racing starts produce one sidecar (IPC-12). */
function takeDaemonLock(files: RuntimeFiles): 'taken' | 'held' {
  if (heldLocks.has(files.lock)) return 'held';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(files.lock, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, atMs: Date.now() }));
      closeSync(fd);
      heldLocks.add(files.lock);
      return 'taken';
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') return 'held';
      const holder = lockHolder(files.lock);
      if (holder !== undefined && holder !== process.pid && pidAlive(holder)) return 'held';
      if (holder === undefined) {
        // A lock being written right now has no pid yet; only a lock older than 5 s is stale.
        try {
          if (Date.now() - statSync(files.lock).mtimeMs < 5000) return 'held';
        } catch {
          continue;
        }
      }
      try {
        unlinkSync(files.lock);
      } catch {
        // raced; retry
      }
    }
  }
  return 'held';
}

function releaseDaemonLock(files: RuntimeFiles): void {
  if (!heldLocks.has(files.lock)) return;
  heldLocks.delete(files.lock);
  if (lockHolder(files.lock) !== process.pid) return;
  try {
    unlinkSync(files.lock);
  } catch {
    // already gone
  }
}

function probeSocket(path: string, timeoutMs = 300): Promise<'live' | 'dead'> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('live');
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('live');
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve('dead');
    });
  });
}

/** Unlinks a leftover Unix socket whose owner is gone (connect probe, then unlink) (IPC-12). */
async function recoverStaleSocket(path: string): Promise<'clear' | 'live'> {
  if (isNamedPipe(path)) return 'clear';
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) return 'clear';
  if (!st.isSocket()) {
    // Never unlink something that is not a socket.
    return 'live';
  }
  if ((await probeSocket(path)) === 'live') return 'live';
  try {
    unlinkSync(path);
  } catch {
    return 'live';
  }
  return 'clear';
}

/** A fallback socket's name: 16 hex characters of the runtime directory's hash (socketCandidates). */
const FALLBACK_SOCKET_NAME = /^[0-9a-f]{16}\.s$/;
/** A socket younger than this may belong to a sidecar that is binding right now. */
const FALLBACK_SWEEP_MIN_AGE_MS = 60_000;
const FALLBACK_SWEEP_MAX_ENTRIES = 256;

/**
 * Removes dead sockets other sidecars left in the shared fallback directories
 * (`$XDG_RUNTIME_DIR/jevris`, `$TMPDIR/jevris-<uid>`, `/tmp/jevris-<uid>`), for example after a
 * crash or a killed test run. Only an entry named like a fallback socket, that is a socket (never
 * a symlink or a file), owned by this user, older than a minute, in a directory that passes
 * fallbackDirSafe, and that refuses a connection is removed. A socket that answers, or does not
 * answer in time, is live and kept. Returns how many were removed.
 */
export async function sweepStaleFallbackSockets(
  dirs: readonly string[],
  options: { readonly nowMs?: number; readonly minAgeMs?: number; readonly keep?: string; readonly uid?: number } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = options.minAgeMs ?? FALLBACK_SWEEP_MIN_AGE_MS;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  let removed = 0;
  for (const dir of new Set(dirs)) {
    if (!fallbackDirSafe(dir, uid)) continue;
    let names: readonly string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => FALLBACK_SOCKET_NAME.test(entry)).slice(0, FALLBACK_SWEEP_MAX_ENTRIES)) {
      const path = join(dir, name);
      if (path === options.keep) continue;
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (st === undefined || !st.isSocket() || (uid !== undefined && st.uid !== uid)) continue;
      if (nowMs - st.mtimeMs < minAgeMs) continue;
      if ((await probeSocket(path)) === 'live') continue;
      try {
        unlinkSync(path);
        removed += 1;
      } catch {
        // gone already, or not ours to remove
      }
    }
  }
  return removed;
}

function removeIfOwned(files: RuntimeFiles, bootId: string, endpoint: string): void {
  const current = readEndpoint(files);
  if (current !== undefined && current.bootId !== bootId) return;
  for (const path of [files.endpoint, files.pid, files.locality, ...CLIENT_KINDS.map((kind) => files.key(kind))]) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
  if (!isNamedPipe(endpoint)) {
    try {
      const st = lstatSync(endpoint, { throwIfNoEntry: false });
      if (st !== undefined && st.isSocket()) unlinkSync(endpoint);
    } catch {
      // already gone
    }
  }
}

// ------------------------------------------------------------------ endpoint selection

/** Binds, chmods and releases a socket at the path: false when this filesystem cannot hold one. */
function canBindSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ path, readableAll: false, writableAll: false }, () => {
      // The owner-only mode is part of holding the socket; a mount that refuses it fails too.
      let usable = true;
      try {
        chmodSync(path, 0o600);
      } catch {
        usable = false;
      }
      server.close(() => {
        try {
          const st = lstatSync(path, { throwIfNoEntry: false });
          if (st !== undefined && st.isSocket()) unlinkSync(path);
        } catch {
          // already gone
        }
        resolve(usable);
      });
    });
  });
}

async function chooseEndpoint(files: RuntimeFiles, platform: string, env: NodeJS.ProcessEnv, exec?: ExecPort): Promise<string | undefined> {
  if (platform === 'win32') {
    const user = exec !== undefined ? currentUser(exec) : safeCurrentUser();
    const principal = user?.sid ?? `${env['USERDOMAIN'] ?? ''}\\${env['USERNAME'] ?? ''}|${files.dir}`;
    return randomPipeName(principal);
  }
  for (const candidate of socketCandidates(files.dir, env)) {
    if (candidate.fallback) {
      try {
        mkdirSync(candidate.dir, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          try {
            mkdirSync(join(candidate.dir, '..'), { recursive: true });
            mkdirSync(candidate.dir, { mode: 0o700 });
          } catch {
            continue;
          }
        }
      }
      if (!fallbackDirSafe(candidate.dir)) continue;
    }
    if ((await recoverStaleSocket(candidate.path)) === 'live') continue;
    // A home on a filesystem without sockets (a dev container's bind mount of the host home,
    // some network shares) cannot hold the socket: the next candidate is tried (IPC-19).
    if (!candidate.fallback && !(await canBindSocket(candidate.path))) continue;
    return candidate.path;
  }
  return undefined;
}

function safeCurrentUser(): { readonly sid: string } | null {
  try {
    return currentUser((file, args) => {
      const result = spawnSync(file, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000 });
      return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
    });
  } catch {
    return null;
  }
}

/**
 * Windows: replaces the pipe's default DACL (which grants Everyone read) with a protected
 * DACL for the current user and SYSTEM only, through Windows PowerShell's PipeSecurity, then
 * reads it back (IPC-05). The mutual key proof protects the protocol either way.
 */
export function pipeAclScript(pipeName: string): string {
  const short = pipeName.replace(/^\\\\[.?]\\pipe\\/, '');
  return [
    "$ErrorActionPreference='Stop'",
    `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${short.replace(/'/g, "''")}', [System.IO.Pipes.PipeAccessRights]'ReadData, WriteData, ChangePermissions, ReadPermissions', [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)`,
    '$c.Connect(3000)',
    '$s = New-Object System.IO.Pipes.PipeSecurity',
    '$s.SetAccessRuleProtection($true, $false)',
    '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$sys = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')",
    "$s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, 'FullControl', 'Allow')))",
    "$s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($sys, 'FullControl', 'Allow')))",
    '$c.SetAccessControl($s)',
    '$rules = $c.GetAccessControl().GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])',
    '$c.Dispose()',
    "Write-Output ('ME=' + $me.Value)",
    "($rules | ForEach-Object { 'ACE=' + $_.IdentityReference.Value })",
  ].join('\n');
}

/** Parses the script output: owner-only when the ACEs are exactly the user and SYSTEM. */
export function pipeAclOwnerOnly(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const me = lines.find((line) => line.startsWith('ME='))?.slice(3);
  const aces = lines.filter((line) => line.startsWith('ACE=')).map((line) => line.slice(4));
  if (me === undefined || me.length === 0 || aces.length === 0) return false;
  return aces.every((sid) => sid === me || sid === 'S-1-5-18') && aces.includes(me);
}

const POWERSHELL = 'WindowsPowerShell\\v1.0\\powershell.exe';

function pipeAclArgs(pipeName: string): string[] {
  const encoded = Buffer.from(pipeAclScript(pipeName), 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

export function hardenPipeAcl(pipeName: string, exec: ExecPort): boolean {
  const result = exec(POWERSHELL, pipeAclArgs(pipeName));
  return result.status === 0 && pipeAclOwnerOnly(result.stdout);
}

/** The asynchronous form (P8): PowerShell runs without holding the event loop. */
export async function hardenPipeAclAsync(pipeName: string, run: AsyncExecPort): Promise<boolean> {
  const result = await run(POWERSHELL, pipeAclArgs(pipeName));
  return result.status === 0 && pipeAclOwnerOnly(result.stdout);
}

export type AsyncExecPort = (file: string, args: readonly string[]) => Promise<{ readonly status: number | null; readonly stdout: string }>;

function system32(env: NodeJS.ProcessEnv, file: string): string {
  const system = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
  return /^[A-Za-z]:\\/.test(file) ? file : `${system}\\System32\\${file}`;
}

function defaultAsyncExec(env: NodeJS.ProcessEnv): AsyncExecPort {
  return (file, args) =>
    new Promise((resolve) => {
      try {
        execFile(system32(env, file), [...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 20_000 }, (error, stdout) => {
          resolve({ status: execStatus(error), stdout: typeof stdout === 'string' ? stdout : '' });
        });
      } catch {
        resolve({ status: null, stdout: '' });
      }
    });
}

// ------------------------------------------------------------------ start

function idleFrom(options: DaemonOptions, env: NodeJS.ProcessEnv): number {
  if (options.idleMs !== undefined) return Math.max(0, options.idleMs);
  const raw = env['JEVRIS_SIDECAR_IDLE_MS'];
  if (typeof raw === 'string' && /^\d{1,10}$/.test(raw)) return Number(raw);
  return options.supervised === true ? 0 : DEFAULT_IDLE_MS;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonStartResult> {
  const platform = options.platform ?? process.platform;
  // The settings' managed mode ceiling reads the managed policy on every settings read: here it
  // goes through the cached reader (P8), so a request never waits on reg.exe or icacls.
  setManagedPolicyDefaults(sidecarManagedOptions(platform));
  const env = options.env ?? process.env;
  const files = runtimeFiles({ ...(options.home !== undefined ? { home: options.home } : {}), platform, env });
  const paths = jevrisPaths({ ...(options.home !== undefined ? { home: options.home } : {}), platform, env });
  const runtimeDir = await ensurePrivateDir(files.dir, { platform, env, ...(options.exec !== undefined ? { exec: options.exec } : {}) });
  if (!runtimeDir.ok) {
    return { ok: false, reason: 'runtime-dir', message: `The runtime directory ${files.dir} is not private (${runtimeDir.code}). Run \`jevris doctor\`.` };
  }
  const logDir = join(paths.state, 'logs');
  await ensurePrivateDir(logDir, { platform, env });
  const log = options.log ?? createFileLog(join(logDir, 'sidecar.log'));
  // Owner decision 0eb319de: a user file that still says the old default (observe) is moved to
  // the new one (bounded-auto) once per home; the log names the outcome, never the file's content.
  const migrated = await migrateModeDefault({ home: paths.home, env }).catch(() => 'not-now' as const);
  if (migrated === 'migrated') log({ level: 'info', event: 'settings-migrated', reasonCode: 'MODE_DEFAULT_BOUNDED_AUTO' });
  // P7: queued log lines reach the file before a failed start returns or the process exits.
  const flushLog = (): void => {
    const flush = Reflect.get(log, 'flushSync');
    if (typeof flush === 'function') (flush as () => void)();
  };
  // Read before anything else, so it is the build this process loaded, not one installed later.
  const buildPorts = options.build ?? { loaded: loadedRuntimeBuild, onDisk: () => runtimeBuild() };
  let ownBuild: RuntimeBuild | null;
  try {
    ownBuild = buildPorts.loaded();
  } catch {
    ownBuild = null;
  }

  // IPC-19: a live sidecar from another execution environment (a container sharing this home,
  // WSL, another host) is left alone: its pid and socket mean nothing here, and taking over
  // its files would strand it. This process runs next to the coding process or not at all.
  const locality = detectLocality({ env });
  if (foreignSidecar(files, readEndpoint(files, platform), locality.id, Date.now(), platform) !== undefined) {
    return { ok: false, reason: 'foreign-locality', message: FOREIGN_LOCALITY_MESSAGE };
  }
  if (takeDaemonLock(files) === 'held') {
    return { ok: false, reason: 'already-running', message: 'A Jevris sidecar is already running for this home.' };
  }
  let loaded: LoadedOps;
  try {
    loaded = await loadOps({
      ...(options.ops !== undefined ? { extraOps: options.ops } : {}),
      ...(options.subscribers !== undefined ? { extraSubscribers: options.subscribers } : {}),
      packages: options.packageOps !== false,
    });
  } catch (error) {
    releaseDaemonLock(files);
    const message = error instanceof Error ? error.message : 'duplicate sidecar op';
    log({ level: 'error', event: 'op-conflict', message });
    flushLog();
    return { ok: false, reason: 'duplicate-op', message };
  }

  // A pidfile or endpoint from a killed sidecar is stale once we hold the lock (IPC-12).
  const previous = readEndpoint(files, platform);
  if (previous !== undefined && !isNamedPipe(previous.endpoint)) await recoverStaleSocket(previous.endpoint);
  for (const path of [files.endpoint, files.pid, files.locality]) {
    try {
      unlinkSync(path);
    } catch {
      // nothing stale
    }
  }

  const endpointPath = await chooseEndpoint(files, platform, env, options.exec);
  if (endpointPath === undefined) {
    releaseDaemonLock(files);
    return { ok: false, reason: 'no-socket-path', message: 'No private socket path is available (every candidate was too long or unsafe). Set JEVRIS_HOME to a shorter path.' };
  }

  const state = await openRuntimeState({
    home: paths.home,
    paths,
    log,
    openStore: options.store !== false,
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.subscriberSliceMs !== undefined ? { subscriberSliceMs: options.subscriberSliceMs } : {}),
    ...(options.liveCertification !== undefined ? { liveCertification: options.liveCertification } : {}),
    ...(options.modelOffer !== undefined ? { modelOffer: options.modelOffer } : {}),
    ...(options.modelOfferIdleMs !== undefined ? { modelOfferIdleMs: options.modelOfferIdleMs } : {}),
    ...(options.accessResumeMs !== undefined ? { accessResumeMs: options.accessResumeMs } : {}),
    ...(options.eventClock !== undefined ? { eventClock: options.eventClock } : {}),
    ...(options.admission !== undefined ? { admission: options.admission } : {}),
    ...(options.backgroundConcurrency !== undefined ? { backgroundConcurrency: options.backgroundConcurrency } : {}),
    ...(options.backgroundMemoryBytes !== undefined ? { backgroundMemoryBytes: options.backgroundMemoryBytes } : {}),
    ...(options.maintenanceWorker !== undefined ? { maintenanceWorker: options.maintenanceWorker } : {}),
    ...(options.ownedWorktrees !== undefined ? { ownedWorktrees: options.ownedWorktrees } : {}),
    ...(options.hostRouteCertified !== undefined ? { hostRouteCertified: options.hostRouteCertified } : {}),
    locality,
  });

  let lastActivity = Date.now();
  let stopping: Promise<void> | undefined;
  let resolveStopped: (reason: string) => void = () => undefined;
  const stopped = new Promise<string>((resolve) => {
    resolveStopped = resolve;
  });
  let service: SidecarService;
  let newerClient = false;
  try {
    service = await startService({
      home: paths.home,
      endpoint: endpointPath,
      version: jevrisPackage().version,
      ops: state.ops(loaded, () => {
        void daemon.stop('shutdown');
      }),
      workspaces: state.workspaces,
      hooks: {
        killSwitchStopped: () => state.killSwitchStopped(),
        storeFor: (workspace) => state.storeFor(workspace),
        adviceAdherenceFor: (workspace) => state.adviceAdherenceFor(workspace),
        engine: state.engine,
        modeOf: (workspace) => state.modeOf(workspace),
        jevAssistOf: (workspace) => state.jevAssistOf(workspace),
        trace: (entry: SidecarTraceEvent & { readonly ws: string; readonly op: string }) => {
          state.trace(entry);
        },
        requestReceived: state.requestReceived,
        requestDone: state.requestDone,
        // IPC-10, TOOL-10: D's stored per-workspace owned mode, read per request; the
        // environment never grants it.
        ownedModeGrant: { op: OWNED_MODE_OP, enabled: (workspace) => workspace.id !== 'global' && ownedModeEnabled(paths.home, workspace.id) },
      },
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      admission: state.admission,
      log,
      ...(options.now !== undefined ? { now: options.now } : {}),
      onActivity: () => {
        lastActivity = Date.now();
      },
      onNewerClient: () => {
        newerClient = true;
        void daemon.stop('version-skew');
      },
      afterListen: () => {
        if (!isNamedPipe(endpointPath)) chmodSync(endpointPath, 0o600);
      },
    });
  } catch (error) {
    await state.close();
    releaseDaemonLock(files);
    log({ level: 'error', event: 'listen-failed', code: errorCode(error) });
    flushLog();
    return { ok: false, reason: 'listen-failed', message: `The sidecar could not listen (${errorCode(error)}). Run \`jevris doctor\`.` };
  }
  state.attach(service, loaded);

  // Keys first, endpoint last: a client that sees the endpoint can already authenticate.
  for (const kind of CLIENT_KINDS) {
    const written = await writePrivateFile(files.key(kind as SidecarClientKind), `${b64url(service.keys[kind as SidecarClientKind])}\n`, { platform, env });
    if (!written.ok) log({ level: 'error', event: 'key-write-failed', kind });
  }
  const endpoint: SidecarEndpointFile = {
    schemaVersion: ENDPOINT_SCHEMA,
    protocol: PROTOCOL,
    version: jevrisPackage().version,
    pid: process.pid,
    bootId: service.bootId,
    endpoint: endpointPath,
    startedAtMs: service.startedAtMs,
    supervised: options.supervised === true,
    ...(ownBuild === null ? {} : { build: ownBuild.id }),
  };
  await writePrivateFile(files.pid, `${process.pid}\n`, { platform, env });
  await writePrivateFile(files.locality, localityRecordText(service.bootId, locality, Date.now()), { platform, env });
  await writePrivateFile(files.endpoint, `${JSON.stringify(endpoint)}\n`, { platform, env });
  try {
    unlinkSync(files.spawnLock);
  } catch {
    // a manual start has no spawn lock
  }

  let pipeAcl: SidecarDaemon['pipeAcl'] = isNamedPipe(endpointPath) ? 'pending' : 'not-applicable';
  if (isNamedPipe(endpointPath)) {
    // P8: the ACL is hardened by an asynchronous PowerShell run, so the first requests are
    // served meanwhile (the mutual key proof protects the protocol either way). An injected
    // synchronous exec (tests) keeps the earlier form.
    const injected = options.exec;
    const hardened = injected !== undefined ? new Promise<boolean>((resolve) => setImmediate(() => resolve(hardenPipeAcl(endpointPath, injected)))) : hardenPipeAclAsync(endpointPath, defaultAsyncExec(env));
    void hardened.then(
      (ok) => {
        pipeAcl = ok ? 'owner-only' : 'default';
        log({ level: pipeAcl === 'owner-only' ? 'info' : 'warn', event: 'pipe-acl', result: pipeAcl });
      },
      () => {
        pipeAcl = 'default';
        log({ level: 'warn', event: 'pipe-acl', result: pipeAcl });
      },
    );
  }

  const idleMs = idleFrom(options, env);
  const backgroundWork = options.backgroundWork ?? activeVerificationRuns;
  let idleTimer: NodeJS.Timeout | undefined;
  if (idleMs > 0) {
    const period = Math.max(10, Math.min(Math.floor(idleMs / 4), 30_000));
    idleTimer = setInterval(() => {
      if (service.connections() > 0 || service.inFlight() > 0) return;
      // A verification run in progress is activity: the idle period starts when it ends.
      let working = 0;
      try {
        working = backgroundWork();
      } catch {
        working = 0;
      }
      if (working > 0) {
        lastActivity = Date.now();
        return;
      }
      if (Date.now() - lastActivity >= idleMs) void daemon.stop('idle');
    }, period);
    idleTimer.unref();
  }
  // A reinstall that replaced this sidecar's runtime with another build (the same version or
  // not) retires it once it is idle: no connection, no request and no verification run under
  // way. The next hook or command starts the installed build; a supervised sidecar exits with
  // STALE_BUILD_EXIT_CODE so its service manager starts it again.
  let buildTimer: NodeJS.Timeout | undefined;
  if (ownBuild !== null) {
    const loadedId = ownBuild.id;
    buildTimer = setInterval(() => {
      if (service.connections() > 0 || service.inFlight() > 0) return;
      let working = 0;
      try {
        working = backgroundWork();
      } catch {
        working = 1;
      }
      if (working > 0) return;
      let onDisk: RuntimeBuild | null = null;
      try {
        onDisk = buildPorts.onDisk();
      } catch {
        onDisk = null;
      }
      if (onDisk === null || onDisk.id === loadedId) return;
      log({ level: 'info', event: 'stale-build', loaded: loadedId, installed: onDisk.id });
      void daemon.stop('stale-build');
    }, Math.max(10, buildPorts.checkMs ?? BUILD_CHECK_MS));
    buildTimer.unref();
  }
  // The locality record is refreshed while the sidecar runs; one left by a crash goes stale.
  const localityTimer = setInterval(() => {
    void writePrivateFile(files.locality, localityRecordText(service.bootId, locality, Date.now()), { platform, env });
  }, LOCALITY_REFRESH_MS);
  localityTimer.unref();
  const sweepTimer = setInterval(() => {
    void state.dailyMaintenance();
  }, 24 * 60 * 60 * 1000);
  sweepTimer.unref();
  void state.startupMaintenance();
  // Dead sockets left in the shared fallback directories by crashed or killed sidecars (IPC-12).
  if (platform !== 'win32') {
    const fallbackDirs = socketCandidates(files.dir, env).filter((candidate) => candidate.fallback).map((candidate) => candidate.dir);
    void sweepStaleFallbackSockets(fallbackDirs, { keep: endpointPath }).then(
      (removed) => {
        if (removed > 0) log({ level: 'info', event: 'stale-sockets-removed', removed });
      },
      () => undefined,
    );
  }

  log({ level: 'info', event: 'started', version: endpoint.version, supervised: endpoint.supervised, idleMs, fallbackSocket: !endpointPath.startsWith(files.dir) });

  const daemon: SidecarDaemon = {
    service,
    files,
    endpoint,
    state,
    get pipeAcl() {
      return pipeAcl;
    },
    stopped,
    stop(reason: string): Promise<void> {
      if (stopping !== undefined) return stopping;
      stopping = (async () => {
        if (idleTimer !== undefined) clearInterval(idleTimer);
        if (buildTimer !== undefined) clearInterval(buildTimer);
        clearInterval(sweepTimer);
        clearInterval(localityTimer);
        log({ level: 'info', event: 'stopping', reason });
        await service.close(5000);
        await state.close();
        removeIfOwned(files, service.bootId, endpointPath);
        releaseDaemonLock(files);
        log({ level: 'info', event: 'stopped', reason, newerClient });
        flushLog();
        resolveStopped(reason);
      })();
      return stopping;
    },
  };
  return { ok: true, daemon };
}

/**
 * `jevris sidecar run`: starts the daemon in this process, installs signal handlers
 * (SIGTERM, SIGINT, SIGHUP; SIGBREAK on Windows) and exits when it stops.
 */
export async function runSidecarMain(options: DaemonOptions & { readonly write?: (text: string) => void } = {}): Promise<number> {
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  // GOV-06: a key in the environment is never read here and no child inherits it.
  scrubCredentialEnv(options.env ?? process.env);
  // Signal handlers go in before the endpoint exists: a SIGTERM that arrives while the
  // daemon is still starting is latched and drains it as soon as it is up, instead of
  // killing the process with the default action and leaving stale files.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  let running: { stop(reason: string): Promise<void> } | undefined;
  let pending: NodeJS.Signals | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      if (running !== undefined) void running.stop(signal);
      else pending ??= signal;
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const removeHandlers = (): void => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  let started: Awaited<ReturnType<typeof startDaemon>>;
  try {
    started = await startDaemon(options);
  } catch (error) {
    removeHandlers();
    throw error;
  }
  if (!started.ok) {
    removeHandlers();
    write(`${started.message}\n`);
    return started.reason === 'already-running' ? 0 : 2;
  }
  const { daemon } = started;
  running = daemon;
  if (pending !== undefined) void daemon.stop(pending);
  const reason = await daemon.stopped;
  removeHandlers();
  return reason === 'stale-build' && options.supervised === true ? STALE_BUILD_EXIT_CODE : 0;
}

export function newBootKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}
