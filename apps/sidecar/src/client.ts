import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type {
  EnsureSidecarInput,
  EnsureSidecarResult,
  SidecarBudgetClass,
  SidecarClientKind,
  SidecarEndpointFile,
  SidecarRequestInput,
  SidecarRequestResult,
} from '@jevris/contracts';
import { detectLocality } from './locality.js';
import { askServiceToStart, defaultServiceRun, serviceInputForHome, serviceUnitState, type ServiceInput, type ServicePlatform, type ServiceRun } from './service-units.js';
// P8: the hook launcher appends its deadline misses through this client entry (E's bin.ts).
export { HOOK_LATENCY_FILE, HOOK_LATENCY_FILE_MAX_BYTES, appendHookLatency, hookLatencyFile, hookLatencyLine, parseHookLatencyLine } from './hook-latency.js';
export type { HookLatencyEntry } from './hook-latency.js';
import { readSharedFileSync } from '@jevris/platform';
import {
  CREDENTIAL_ENV_NAME,
  FOREIGN_LOCALITY_MESSAGE,
  LineReader,
  PROTOCOL,
  isNamedPipe,
  jevrisPackage,
  macEquals,
  newNonce,
  parseLine,
  foreignSidecar,
  pidAlive,
  readClientKey,
  readEndpoint,
  requestMac,
  requestPriority,
  responseMac,
  runtimeFiles,
  serverProof,
  type RuntimeFiles,
} from './protocol.js';

/**
 * The sidecar client (agreed interface with domain E). No store, provider or keyring import:
 * the hook vendors this file. The client never sends a request before the server has proved
 * the per-kind key (IPC-03), and every request carries a fresh nonce and MAC (IPC-01, IPC-02).
 */

export type { EnsureSidecarInput, EnsureSidecarResult, SidecarRequestInput, SidecarRequestResult };

/** This process's locality id (IPC-19); read once, since it never changes while a process runs. */
let ownLocality: { readonly root: string | undefined; readonly id: string } | undefined;
function ownLocalityId(): string {
  const root = process.env['JEVRIS_TEST'] === '1' ? process.env['JEVRIS_TEST_LOCALITY_ROOT'] : undefined;
  if (ownLocality === undefined || ownLocality.root !== root) ownLocality = { root, id: detectLocality().id };
  return ownLocality.id;
}

/** True when the endpoint belongs to a sidecar in another execution environment (US37). */
function isForeign(files: RuntimeFiles, endpoint: SidecarEndpointFile | undefined): boolean {
  return foreignSidecar(files, endpoint, ownLocalityId(), Date.now()) !== undefined;
}

const DEFAULT_TIMEOUT: { readonly [K in SidecarClientKind]: number } = { hook: 900, mcp: 5000, cli: 5000 };
const SPAWN_LOCK_STALE_MS = 10_000;
/**
 * The "not running" answer. Where a start is allowed it says the sidecar starts on demand; with
 * JEVRIS_SIDECAR_AUTOSTART=0 nothing starts it, so it names the two fixes instead and never
 * promises a start. Text only: the reason codes are chosen by the callers.
 */
function notRunningMessage(): string {
  return process.env['JEVRIS_SIDECAR_AUTOSTART'] === '0'
    ? 'The Jevris sidecar is not running, and autostart is off (JEVRIS_SIDECAR_AUTOSTART=0), so nothing will start it. Run `jevris sidecar start`, or unset JEVRIS_SIDECAR_AUTOSTART.'
    : 'The Jevris sidecar is not running. Run `jevris sidecar start`, or retry: it starts on demand.';
}

function fail(
  reason: 'unavailable' | 'refused' | 'timeout' | 'rejected',
  message: string,
  reasonCode?: string,
): SidecarRequestResult {
  return reasonCode === undefined ? { ok: false, reason, message } : { ok: false, reason, reasonCode, message };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string') return code;
  }
  return 'EUNKNOWN';
}

function rejectionMessage(code: string): string {
  switch (code) {
    case 'SCOPE_DENIED':
      return 'This client may not run that operation. Run it from the jevris CLI in a terminal.';
    case 'KILL_SWITCH':
      return 'The Jevris kill switch is stopped. Run `jevris kill-switch status` to see why.';
    case 'VERSION_MISMATCH':
      return 'The running sidecar is a different Jevris version. Run `jevris sidecar restart`.';
    case 'UNKNOWN_OP':
      return 'The sidecar does not know that operation. Update Jevris, then run `jevris sidecar restart`.';
    case 'UNKNOWN_WORKSPACE':
    case 'CROSS_WORKSPACE':
      return 'That workspace is not registered with this sidecar. Run the command from inside the workspace.';
    case 'STORE_UNAVAILABLE':
      return 'The Jevris store is unavailable. Run `jevris doctor` for the store health line.';
    case 'DEADLINE':
      return 'The sidecar could not answer inside the deadline; this call ran rules-only.';
    case 'BUSY':
      return 'The sidecar is busy; this call ran rules-only. Retry in a moment.';
    case 'SHUTTING_DOWN':
      return 'The sidecar is shutting down; retry to start a fresh one.';
    default:
      return `The sidecar refused the request (${code}). Run \`jevris doctor\` for details.`;
  }
}

interface Exchange {
  readonly socket: Socket;
  readonly reader: LineReader;
}

type OpenResult = Socket | 'ENOENT' | 'ECONNREFUSED' | 'EAGAIN' | 'timeout' | 'error';

function openSocket(endpoint: string, timeoutMs: number): Promise<OpenResult> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    let settled = false;
    const timer = setTimeout(() => {
      finish('timeout');
    }, Math.max(1, timeoutMs));
    const finish = (value: OpenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof value === 'string') socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => {
      finish(socket);
    });
    socket.once('error', (error) => {
      const code = errorCode(error);
      finish(code === 'ENOENT' ? 'ENOENT' : code === 'ECONNREFUSED' ? 'ECONNREFUSED' : code === 'EAGAIN' ? 'EAGAIN' : 'error');
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/**
 * Connects, and retries a refused connect while the endpoint's process is alive (concurrency
 * audit, 100 subagents: a full listen backlog refuses the connect, ECONNREFUSED on macOS and
 * EAGAIN on Linux, while the sidecar is busy but running). Short jittered waits, never past the
 * request's deadline; a dead endpoint process answers at once as before.
 */
async function openWithRetry(endpoint: SidecarEndpointFile, deadlineAt: number): Promise<OpenResult> {
  let attempt = 0;
  for (;;) {
    const opened = await openSocket(endpoint.endpoint, remaining(deadlineAt));
    if (opened !== 'ECONNREFUSED' && opened !== 'EAGAIN') return opened;
    const waitMs = Math.min(5 * 2 ** Math.min(attempt, 3), 40) + Math.floor(Math.random() * 10);
    if (Date.now() + waitMs >= deadlineAt - 50 || !alive(endpoint.pid)) return opened;
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function remaining(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

/**
 * Sends one request. The failure reasons are the agreed degraded states: `unavailable` (no
 * sidecar), `refused` (the client refused the server, for example an unproven key),
 * `timeout`, and `rejected` (the sidecar refused the request, with its reason code).
 */
export async function sidecarRequest(input: SidecarRequestInput): Promise<SidecarRequestResult> {
  const kind = input.scope;
  if (kind !== 'cli' && kind !== 'hook' && kind !== 'mcp') return fail('refused', 'Unknown client kind.', 'UNKNOWN_CLIENT');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT[kind];
  const deadlineAt = Date.now() + timeoutMs;
  const files = runtimeFiles(input.home !== undefined ? { home: input.home } : {});
  const endpoint = readEndpoint(files);
  if (endpoint === undefined) return fail('unavailable', notRunningMessage(), 'NOT_RUNNING');
  // A sidecar in another execution environment is not this process's worker (IPC-19).
  if (isForeign(files, endpoint)) return fail('unavailable', FOREIGN_LOCALITY_MESSAGE, 'FOREIGN_LOCALITY');
  const key = readClientKey(files, kind);
  if (key === undefined) return fail('unavailable', notRunningMessage(), 'KEY_UNREADABLE');
  if (input.signal?.aborted === true) return fail('timeout', 'The request was cancelled before it was sent.', 'ABORTED');
  let body: string;
  try {
    body = JSON.stringify(input.body ?? null);
  } catch {
    return fail('rejected', 'The request body is not JSON.', 'MALFORMED');
  }
  if (Buffer.byteLength(body, 'utf8') > 131_072) return fail('rejected', 'The request body is too large.', 'OVERSIZE');

  const opened = await openWithRetry(endpoint, deadlineAt);
  if (opened === 'timeout') return fail('timeout', 'The sidecar did not accept the connection in time.', 'CONNECT_TIMEOUT');
  if (typeof opened === 'string') return fail('unavailable', notRunningMessage(), opened === 'error' ? 'CONNECT_FAILED' : opened);
  const exchange: Exchange = { socket: opened, reader: new LineReader(opened, { idleMs: remaining(deadlineAt), frameMs: remaining(deadlineAt) }) };
  const onAbort = (): void => {
    exchange.socket.destroy();
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await converse(exchange, input, key, endpoint, body, deadlineAt);
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    exchange.socket.destroy();
  }
}

async function converse(
  exchange: Exchange,
  input: SidecarRequestInput,
  key: Uint8Array,
  endpoint: SidecarEndpointFile,
  body: string,
  deadlineAt: number,
): Promise<SidecarRequestResult> {
  const { socket, reader } = exchange;
  const cnonce = newNonce();
  socket.write(`${JSON.stringify({ t: 'hello', v: PROTOCOL, client: input.scope, cnonce, runtimeVersion: jevrisPackage().version })}\n`);
  reader.setIdle(remaining(deadlineAt));
  const first = await reader.next();
  if (first.kind === 'timeout') return fail('timeout', 'The sidecar did not answer the handshake in time.', 'HANDSHAKE_TIMEOUT');
  if (first.kind !== 'line') {
    if (input.signal?.aborted === true) return fail('timeout', 'The request was cancelled.', 'ABORTED');
    return fail('unavailable', notRunningMessage(), 'CLOSED');
  }
  const challenge = parseLine(first.text);
  if (challenge === undefined) return fail('refused', 'The sidecar answered with a malformed handshake.', 'SERVER_UNPROVEN');
  if (challenge['t'] === 'error') {
    const code = typeof challenge['reasonCode'] === 'string' ? challenge['reasonCode'] : 'REFUSED';
    return fail('rejected', rejectionMessage(code), code);
  }
  const snonce = challenge['snonce'];
  const bootId = challenge['bootId'];
  if (challenge['t'] !== 'challenge' || typeof snonce !== 'string' || typeof bootId !== 'string') {
    return fail('refused', 'The sidecar answered with a malformed handshake.', 'SERVER_UNPROVEN');
  }
  // Mutual proof before anything sensitive is sent: a squatted socket or pipe cannot answer.
  if (bootId !== endpoint.bootId || !macEquals(serverProof(key, cnonce, snonce, bootId), challenge['proof'])) {
    return fail('refused', 'The process on the sidecar endpoint could not prove the Jevris key; nothing was sent. Run `jevris sidecar restart`.', 'SERVER_UNPROVEN');
  }
  const id = newNonce();
  const ts = Date.now();
  const eventAtMs = typeof input.eventAtMs === 'number' && Number.isFinite(input.eventAtMs) ? Math.trunc(input.eventAtMs) : null;
  const budget: SidecarBudgetClass = input.budget ?? (input.scope === 'hook' ? 'hot' : 'background');
  const ws = typeof input.workspace === 'string' ? input.workspace : '';
  // The sidecar stops waiting when this client does (IPC-15): no work after the client gave up.
  const deadlineAtMs = Math.trunc(deadlineAt);
  // The answer lane: a hook's SessionStart, Stop or PreCompact event (MAC'd; the sidecar checks the kind).
  const priority = requestPriority(input.scope, input.op, input.body);
  const mac = requestMac(key, { snonce, id, ws, op: input.op, ts, eventAtMs, budget, body, deadlineAtMs, priority });
  socket.write(`${JSON.stringify({ t: 'req', v: PROTOCOL, id, ws, op: input.op, ts, eventAtMs, budget, body, deadlineAtMs, ...(priority === null ? {} : { priority }), mac })}\n`);
  reader.setIdle(remaining(deadlineAt));
  const reply = await reader.next();
  if (reply.kind === 'timeout') return fail('timeout', 'The sidecar did not answer in time; this call ran rules-only.', 'TIMEOUT');
  if (reply.kind !== 'line') {
    if (input.signal?.aborted === true) return fail('timeout', 'The request was cancelled.', 'ABORTED');
    return fail('unavailable', notRunningMessage(), 'CLOSED');
  }
  const res = parseLine(reply.text);
  if (res === undefined) return fail('refused', 'The sidecar answered with a malformed frame.', 'MALFORMED_RESPONSE');
  if (res['t'] === 'error') {
    const code = typeof res['reasonCode'] === 'string' ? res['reasonCode'] : 'REFUSED';
    return fail('rejected', rejectionMessage(code), code);
  }
  const payload = res['payload'];
  if (res['t'] !== 'res' || res['id'] !== id || typeof payload !== 'string' || !macEquals(responseMac(key, snonce, id, payload), res['mac'])) {
    return fail('refused', 'The sidecar response did not verify; it was ignored.', 'BAD_RESPONSE_MAC');
  }
  const outcome = parseLine(payload);
  if (outcome === undefined) return fail('refused', 'The sidecar answered with a malformed payload.', 'MALFORMED_RESPONSE');
  if (outcome['ok'] === true) return { ok: true, result: outcome['body'] ?? null };
  const code = typeof outcome['reasonCode'] === 'string' ? outcome['reasonCode'] : 'REFUSED';
  const message = typeof outcome['message'] === 'string' && outcome['message'].length > 0 ? outcome['message'] : rejectionMessage(code);
  return fail('rejected', message, code);
}

// ------------------------------------------------------------------ probe and ensure

export interface SidecarProbe {
  readonly running: boolean;
  readonly endpoint: SidecarEndpointFile | undefined;
  /** The socket or pipe accepted a connection. */
  readonly reachable: boolean;
  /** The endpoint belongs to a sidecar in another execution environment (IPC-19). */
  readonly foreign?: true;
}

/** Reads the endpoint file and tries a connection; no key is used and nothing is sent. */
export async function probeSidecar(home?: string, timeoutMs = 300): Promise<SidecarProbe> {
  const files = runtimeFiles(home !== undefined ? { home } : {});
  const endpoint = readEndpoint(files);
  // Its pid means nothing in this pid namespace, and it is not this process's worker.
  if (isForeign(files, endpoint)) return { running: false, endpoint, reachable: false, foreign: true };
  if (endpoint === undefined || !pidAlive(endpoint.pid)) return { running: false, endpoint, reachable: false };
  const opened = await openSocket(endpoint.endpoint, timeoutMs);
  if (typeof opened === 'string') return { running: false, endpoint, reachable: false };
  opened.destroy();
  return { running: true, endpoint, reachable: true };
}

/**
 * The daemon command line: the bundled `entries.sidecar` from dist/runtime/manifest.json in
 * an installed package, else `bin/jevris.mjs sidecar run` in a source tree.
 */
export function sidecarCommand(): readonly string[] | undefined {
  const override = process.env['JEVRIS_SIDECAR_ENTRY'];
  if (typeof override === 'string' && override.length > 0) return [override];
  const root = jevrisPackage().root;
  if (root === null) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'dist', 'runtime', 'manifest.json'), 'utf8')) as { readonly entries?: { readonly sidecar?: unknown } };
    const entry = manifest.entries?.sidecar;
    if (typeof entry === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(entry) && !entry.includes('..')) {
      const full = join(root, ...entry.split('/'));
      if (statSync(full).isFile()) return [full];
    }
  } catch {
    // no manifest: a source tree
  }
  const bin = join(root, 'bin', 'jevris.mjs');
  try {
    return statSync(bin).isFile() ? [bin, 'sidecar', 'run'] : undefined;
  } catch {
    return undefined;
  }
}

/** How the caller that took the spawn lock meant to start the sidecar. */
type StartVia = 'service' | 'spawn';

/**
 * Takes the spawn lock with an exclusive create; a lock older than the stale window is replaced.
 * The lock records how the start was made. A replaced lock that was a service start tells the new
 * holder that the service did not bring a sidecar up in the window (`previousVia`).
 */
function takeSpawnLock(files: RuntimeFiles, via: StartVia): { readonly previousVia: StartVia | undefined } | false {
  let previousVia: StartVia | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(files.spawnLock, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, atMs: Date.now(), via }));
      closeSync(fd);
      return { previousVia };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      if (errorCode(error) !== 'EEXIST') return false;
      if (!spawnLockStale(files)) return false;
      previousVia = spawnLockVia(files);
      try {
        unlinkSync(files.spawnLock);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function spawnLockVia(files: RuntimeFiles): StartVia | undefined {
  try {
    const parsed = JSON.parse(readSharedFileSync(files.spawnLock, 'utf8')) as { readonly via?: unknown };
    return parsed.via === 'service' || parsed.via === 'spawn' ? parsed.via : undefined;
  } catch {
    return undefined;
  }
}

function spawnLockStale(files: RuntimeFiles): boolean {
  try {
    const text = readSharedFileSync(files.spawnLock, 'utf8');
    const parsed = JSON.parse(text) as { readonly pid?: unknown; readonly atMs?: unknown; readonly via?: unknown };
    const atMs = typeof parsed.atMs === 'number' ? parsed.atMs : 0;
    // A service start belongs to the service manager, not to the caller that asked: that caller
    // (a hook) is gone within milliseconds while the manager's sidecar is still starting. Only age
    // ends it.
    if (parsed.via === 'service') return Date.now() - atMs > SPAWN_LOCK_STALE_MS;
    // A spawner that died (an update or a crash killed it) holds nothing: take the lock now
    // rather than leave every caller rules-only for the stale window.
    if (typeof parsed.pid === 'number' && parsed.pid !== process.pid && !pidAlive(parsed.pid)) return true;
    return Date.now() - atMs > SPAWN_LOCK_STALE_MS;
  } catch {
    try {
      return Date.now() - statSync(files.spawnLock).mtimeMs > SPAWN_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
}

function releaseSpawnLock(files: RuntimeFiles): void {
  try {
    unlinkSync(files.spawnLock);
  } catch {
    // The daemon removes it once it listens.
  }
}

/** The environment of the detached sidecar: no Jev key variable is inherited (GOV-06). */
export function sidecarChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CREDENTIAL_ENV_NAME.test(name)) continue;
    out[name] = value;
  }
  return out;
}

export interface SpawnSidecarOptions {
  readonly home?: string;
  readonly idleMs?: number;
  readonly supervised?: boolean;
}

/** Starts a detached sidecar and returns at once. The daemon's own lock makes a racing start exit. */
export function spawnSidecar(options: SpawnSidecarOptions = {}): boolean {
  const command = sidecarCommand();
  if (command === undefined) return false;
  const args = [...command];
  if (options.home !== undefined) args.push('--home', options.home);
  if (options.idleMs !== undefined) args.push('--idle-ms', String(options.idleMs));
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: sidecarChildEnv(),
      cwd: runtimeCwd(options.home),
    });
    child.on('error', () => {
      // A failed spawn leaves the caller rules-only; the next call retries.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function runtimeCwd(home?: string): string {
  // Never keep a workspace directory busy (Windows) or inherit a repository cwd.
  const files = runtimeFiles(home !== undefined ? { home } : {});
  try {
    if (statSync(files.dir).isDirectory()) return files.dir;
  } catch {
    // fall through
  }
  return home ?? process.cwd();
}

function ensureRuntimeDir(files: RuntimeFiles): boolean {
  try {
    if (statSync(files.dir).isDirectory()) return true;
  } catch {
    // create below
  }
  try {
    // Parents keep default modes; the leaf is private. The daemon tightens it again (and sets the
    // Windows ACL) before it writes any key.
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Referenced on purpose: a CLI awaiting ensureSidecar or stop with nothing else on
    // the event loop must not exit mid-wait.
    setTimeout(resolve, ms);
  });
}

/** The most JEVRIS_SIDECAR_WAIT_MS may set the autostart wait to, under a test run. */
export const SIDECAR_TEST_WAIT_MAX_MS = 60_000;

/**
 * The autostart wait a caller gets: the requested one, except under a test run (JEVRIS_TEST set),
 * where JEVRIS_SIDECAR_WAIT_MS replaces a nonzero wait, clamped to 60 s. A cold start on a loaded
 * test host can outlast the CLI's 5 s. A zero wait (a hook) never blocks, and product behaviour
 * is unchanged. Every autostart path uses this, so the wait and any outer deadline agree.
 */
export function sidecarWaitMs(requested: number, env: { readonly [key: string]: string | undefined } = process.env): number {
  const base = Number.isFinite(requested) ? Math.max(0, requested) : 0;
  if (base === 0) return 0;
  const test = env['JEVRIS_TEST'];
  const raw = env['JEVRIS_SIDECAR_WAIT_MS'];
  if (test === undefined || test === '' || raw === undefined || !/^\d{1,9}$/.test(raw)) return base;
  return Math.min(SIDECAR_TEST_WAIT_MAX_MS, Number(raw));
}

/**
 * How long a caller that must not wait (a hook, `waitMs: 0`) gives the service manager to answer
 * before it leaves the request to finish on its own. A manager answers a start in tens of
 * milliseconds; this is far inside a hook's 900 ms budget, and the hook's own deadline still wins.
 */
export const SERVICE_START_GRACE_MS = 400;
/** The most a caller that waits gives the service manager to answer a start. */
const SERVICE_START_MAX_WAIT_MS = 10_000;

/** Seams for tests: the service manager and the on-demand spawn. Production passes none. */
export interface EnsureSidecarDeps {
  /**
   * `false` never asks a service manager (the caller already did, or has no use for one). Otherwise
   * the seams below replace the real platform, account home and manager commands. Under a test run
   * (JEVRIS_TEST=1) the real manager is never called unless a test supplies `run`.
   */
  readonly service?:
    | false
    | {
        readonly platform?: ServicePlatform;
        readonly osHome?: string;
        readonly run?: ServiceRun;
      };
  /** Starts the detached on-demand sidecar (default spawnSidecar). */
  readonly spawn?: (options: SpawnSidecarOptions) => boolean;
}

/** The unit input when a service is installed for this home, read from the unit file alone; else undefined. */
function installedServiceFor(home: string | undefined, deps: EnsureSidecarDeps): ServiceInput | undefined {
  if (deps.service === false) return undefined;
  const platform = deps.service?.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return undefined;
  try {
    const input = serviceInputForHome({
      ...(home !== undefined ? { home } : {}),
      command: sidecarCommand(),
      platform,
      ...(deps.service?.osHome !== undefined ? { osHome: deps.service.osHome } : {}),
    });
    return serviceUnitState(input) === 'installed' ? input : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a service is installed for this home (the unit file serves it). A read of one small file:
 * no service manager is called.
 */
export function serviceInstalledFor(home?: string): boolean {
  return installedServiceFor(home, {}) !== undefined;
}

/** The runner for the real manager; under a test run no manager is called unless a test injects one. */
function serviceRunFor(deps: EnsureSidecarDeps): ServiceRun {
  const injected = deps.service === false ? undefined : deps.service?.run;
  if (injected !== undefined) return injected;
  if (process.env['JEVRIS_TEST'] === '1') return () => ({ status: 1 });
  return defaultServiceRun(sidecarChildEnv());
}

/** A sidecar the service runs that is alive, though it did not answer: starting another would put two side by side. */
function liveServiceSidecar(files: RuntimeFiles): number | undefined {
  const endpoint = readEndpoint(files);
  return endpoint !== undefined && endpoint.supervised && pidAlive(endpoint.pid) ? endpoint.pid : undefined;
}

/**
 * Starts the sidecar on demand (IPC-13). With `waitMs: 0` it never blocks: a hook starts the
 * sidecar and runs rules-only on that invocation. The CLI and MCP wait up to about 1.5 s.
 * Many parallel callers produce one sidecar: an exclusive spawn lock picks one spawner, and
 * the daemon's own lock makes any second daemon exit.
 *
 * When `jevris service install` set up a service for this home, the start goes through the
 * service manager (launchctl kickstart, systemctl --user start, schtasks /Run), so the sidecar that
 * comes up is the supervised one and no second, unsupervised sidecar is spawned beside it. The
 * manager is given a short grace to answer (about 0.4 s for a caller that does not wait; never past
 * `waitMs` for one that does) and is then left to finish on its own, so a hook stays inside its
 * deadline. If the manager refuses or cannot be run, the on-demand spawn below is used, unless a
 * sidecar the service runs is still alive: then nothing is spawned and the reason is reported.
 * A service start that left no sidecar within the lock window is not repeated: the next call spawns.
 * With no service installed nothing changes. JEVRIS_SIDECAR_AUTOSTART=0 is the callers' to honour.
 */
export async function ensureSidecar(input: EnsureSidecarInput = {}, deps: EnsureSidecarDeps = {}): Promise<EnsureSidecarResult> {
  const home = input.home;
  const waitMs = sidecarWaitMs(input.waitMs ?? 0);
  const probe = await probeSidecar(home);
  if (probe.running && probe.endpoint !== undefined) return { ok: true, endpoint: probe.endpoint.endpoint, started: false };
  if (probe.foreign === true) return { ok: false, reason: 'refused', message: FOREIGN_LOCALITY_MESSAGE };
  const files = runtimeFiles(home !== undefined ? { home } : {});
  if (!ensureRuntimeDir(files)) {
    return { ok: false, reason: 'refused', message: 'The Jevris runtime directory could not be created. Run `jevris doctor`.' };
  }
  const beganAt = Date.now();
  const service = installedServiceFor(home, deps);
  let spawned = false;
  const lock = takeSpawnLock(files, service === undefined ? 'spawn' : 'service');
  if (lock !== false) {
    let viaService = false;
    // The previous service start left no sidecar within the lock window: this call spawns instead.
    if (service !== undefined && lock.previousVia !== 'service') {
      const asked = await askServiceToStart(service, serviceRunFor(deps), waitMs === 0 ? SERVICE_START_GRACE_MS : Math.min(waitMs, SERVICE_START_MAX_WAIT_MS));
      if (asked.outcome === 'started' || asked.outcome === 'pending') {
        viaService = true;
        spawned = true;
      } else {
        const alive = liveServiceSidecar(files);
        if (alive !== undefined) {
          releaseSpawnLock(files);
          const code = asked.outcome === 'refused' ? 'SERVICE_START_REFUSED' : 'SERVICE_UNREACHABLE';
          return {
            ok: false,
            reason: 'unavailable',
            reasonCode: code,
            message: `${asked.manager} ${asked.outcome === 'refused' ? 'refused to start' : 'could not be reached to start'} the Jevris sidecar service (${code}), and the sidecar the service runs (pid ${String(alive)}) is alive but did not answer, so no second sidecar was started. Run \`jevris service status\`, then \`jevris sidecar restart\`.`,
          };
        }
        // Safe: no service-run sidecar is alive, so the on-demand spawn below starts the only one.
      }
    }
    if (!viaService) {
      spawned = (deps.spawn ?? spawnSidecar)(home !== undefined ? { home } : {});
      if (!spawned) {
        releaseSpawnLock(files);
        return { ok: false, reason: 'unavailable', message: 'The Jevris sidecar could not be started. Run `jevris sidecar start` to see why.' };
      }
    }
  }
  const until = beganAt + waitMs;
  while (Date.now() < until) {
    await sleep(Math.min(25, Math.max(1, until - Date.now())));
    const next = await probeSidecar(home, 100);
    if (next.running && next.endpoint !== undefined) return { ok: true, endpoint: next.endpoint.endpoint, started: spawned };
  }
  return { ok: false, reason: 'starting', message: 'The Jevris sidecar is starting; this call ran rules-only.' };
}

// ------------------------------------------------------------------ stop

export interface StopResult {
  readonly stopped: boolean;
  readonly method: 'not-running' | 'shutdown-frame' | 'signal' | 'failed';
  readonly pid?: number;
  /** The running sidecar belongs to another execution environment; nothing was signalled. */
  readonly foreign?: true;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return true;
    await sleep(25);
  }
  return !pidAlive(pid);
}

function readPidfile(files: RuntimeFiles): number | undefined {
  try {
    const text = readSharedFileSync(files.pid, 'utf8').trim();
    if (!/^\d{1,10}$/.test(text)) return undefined;
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stops the sidecar (IPC-16): an authenticated admin `shutdown` frame first, then SIGTERM
 * through the pidfile when the frame cannot be delivered.
 */
/** The live pid in a small lock file (`{ pid, atMs }`), other than this process. */
function liveLockPid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readSharedFileSync(path, 'utf8')) as { readonly pid?: unknown; readonly atMs?: unknown };
    const pid = parsed.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !pidAlive(pid)) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/**
 * A spawn under way: a spawn lock younger than the stale window. The spawner (often a hook)
 * may already have exited while its detached child is still starting, so its pid is not read.
 */
function spawnInProgress(files: RuntimeFiles): boolean {
  try {
    const parsed = JSON.parse(readFileSync(files.spawnLock, 'utf8')) as { readonly atMs?: unknown };
    return typeof parsed.atMs === 'number' && Date.now() - parsed.atMs <= SPAWN_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * A sidecar that is starting has taken the daemon lock (or a spawner holds the spawn lock)
 * but has not yet written its endpoint. Waits for the endpoint, so a stop during startup
 * stops it rather than reporting not-running and leaving it to come up (US05). Returns the
 * daemon's pid when its endpoint never appeared in time, so the caller can signal it.
 */
async function awaitStartingSidecar(files: RuntimeFiles, timeoutMs: number): Promise<{ readonly endpoint: SidecarEndpointFile | undefined; readonly lockPid: number | undefined }> {
  const until = Date.now() + timeoutMs;
  let lockPid = liveLockPid(files.lock);
  if (lockPid === undefined && !spawnInProgress(files)) return { endpoint: undefined, lockPid: undefined };
  while (Date.now() < until) {
    const endpoint = readEndpoint(files);
    if (endpoint !== undefined && pidAlive(endpoint.pid)) return { endpoint, lockPid };
    lockPid = liveLockPid(files.lock);
    if (lockPid === undefined && !spawnInProgress(files)) return { endpoint: undefined, lockPid: undefined };
    await sleep(25);
  }
  return { endpoint: readEndpoint(files), lockPid: liveLockPid(files.lock) };
}

export async function stopSidecarProcess(home?: string, timeoutMs = 5000): Promise<StopResult> {
  const files = runtimeFiles(home !== undefined ? { home } : {});
  let endpoint = readEndpoint(files);
  // Never signal a pid written in another pid namespace: here it names an unrelated process.
  if (isForeign(files, endpoint)) return { stopped: false, method: 'failed', foreign: true };
  let pid = endpoint?.pid ?? readPidfile(files);
  if (pid === undefined || !pidAlive(pid) || pid === process.pid) {
    const starting = await awaitStartingSidecar(files, timeoutMs);
    endpoint = starting.endpoint;
    if (isForeign(files, endpoint)) return { stopped: false, method: 'failed', foreign: true };
    pid = endpoint !== undefined && pidAlive(endpoint.pid) ? endpoint.pid : starting.lockPid;
    if (pid === undefined || !pidAlive(pid) || pid === process.pid) return { stopped: true, method: 'not-running' };
  }
  const asked = await sidecarRequest({
    ...(home !== undefined ? { home } : {}),
    op: 'shutdown',
    scope: 'cli',
    body: {},
    timeoutMs: Math.min(2000, timeoutMs),
  });
  if (asked.ok && (await waitForExit(pid, timeoutMs))) return { stopped: true, method: 'shutdown-frame', pid };
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // It may have exited between the checks.
  }
  if (await waitForExit(pid, timeoutMs)) return { stopped: true, method: 'signal', pid };
  return { stopped: false, method: 'failed', pid };
}

export { isNamedPipe };
