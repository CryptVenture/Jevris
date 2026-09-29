/// <reference path="../types/child-process.d.ts" />
/// <reference path="../types/installer.d.ts" />
import { spawn, type PipedChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { planSpawn, resolveExecutable } from '@jevris/platform';

/**
 * The one place that starts a harness binary (claude, kilo, opencode, codex, agy).
 *
 * Tests must never reach a real harness: a real `claude` under a temp HOME asks the
 * macOS keychain for its credential (a dialog on the owner's screen), makes a paid
 * model call, and can leave MCP server grandchildren behind. So:
 *
 * - `JEVRIS_NO_LIVE_HARNESS=1` (set by `scripts/test.mjs`), `JEVRIS_TEST=1` or a node
 *   test context refuse a spawn by bare command name (a PATH lookup). A caller that
 *   injects an explicit binary path is allowed; tests inject a stub.
 * - Every child is started as its own process group and killed as a whole tree on
 *   timeout, after it exits, and when this process exits.
 * - The tripwire: in a test context without JEVRIS_LIVE_HARNESS=1, starting a real harness
 *   binary (or the macOS `security` tool) by an explicit path outside the temporary folder
 *   throws, so the test fails loudly instead of showing a keychain dialog.
 */

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

export const HARNESS_BINARIES = ['claude', 'kilo', 'opencode', 'codex', 'agy'] as const;

type Env = { readonly [key: string]: string | undefined };

export function liveHarnessBlocked(env: Env = process.env): boolean {
  if (env.JEVRIS_NO_LIVE_HARNESS === '1') return true;
  if (env.JEVRIS_TEST === '1') return true;
  return typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT.length > 0;
}

/** A bare name is resolved from PATH; a path with a separator was injected by the caller. */
export function isBareCommand(binary: string): boolean {
  return !binary.includes('/') && !binary.includes('\\');
}

/**
 * A test run starts no harness found on PATH, unless JEVRIS_LIVE_HARNESS=1 asks for a live smoke
 * (or pack smoke's certifiable stand-ins); the tripwire still refuses a real binary under a
 * temp HOME without that flag.
 */
export function spawnRefused(binary: string, env: Env = process.env): boolean {
  return liveHarnessBlocked(env) && env.JEVRIS_LIVE_HARNESS !== '1' && isBareCommand(binary);
}

/** True when this process may start a harness binary: not a test run, or a live smoke. */
export function liveHarnessAllowed(env: Env = process.env): boolean {
  return !liveHarnessBlocked(env) || env.JEVRIS_LIVE_HARNESS === '1';
}

/** A binary's bare name: the last part of either path style, lower case, without a Windows extension. */
function binaryName(file: string): string {
  return basename(file.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** Binaries that can reach the macOS keychain or make a model call. */
export const TRIPWIRE_BINARIES: readonly string[] = [...HARNESS_BINARIES, 'antigravity', 'antigravity-ide', 'security'];

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Throws when a test would start a real harness binary: a test context (JEVRIS_TEST=1,
 * JEVRIS_NO_LIVE_HARNESS=1 or a node test run) without JEVRIS_LIVE_HARNESS=1, a tripwire
 * binary, and a resolved path outside the temporary folder where tests put their stubs.
 */
export function spawnTripwire(file: string, env?: Env): void {
  const envs = env === undefined ? [process.env] : [process.env, env];
  if (!envs.some((e) => liveHarnessBlocked(e)) || envs.some((e) => e.JEVRIS_LIVE_HARNESS === '1')) return;
  const name = binaryName(file);
  if (!TRIPWIRE_BINARIES.includes(name)) return;
  const found = isBareCommand(file) ? resolveExecutable(file, { env: env ?? process.env }) : resolve(file);
  if (found === null) return;
  const real = realOrSelf(found);
  const roots = [tmpdir(), realOrSelf(tmpdir())];
  if (roots.some((root) => within(root, real))) return;
  throw new Error(
    `jevris test tripwire: refused to start the real ${name} (${real}) during a test. A real harness under a temporary HOME asks the macOS keychain and shows a dialog. Inject a stub inside the temporary folder, or set JEVRIS_LIVE_HARNESS=1 for a live smoke.`,
  );
}

/** The OS account's home from the account database, not from HOME (which a test or certify changes). */
export function accountHome(): string | null {
  try {
    // node:os declares userInfo here with username only; homedir is always present at runtime.
    const home = (userInfo() as unknown as { readonly homedir?: unknown }).homedir;
    return typeof home === 'string' && home.length > 0 ? home : null;
  } catch {
    return null;
  }
}

/**
 * Why a harness status probe must not run here, or null when it may: a test context without
 * the live flag, or a HOME (or Jevris home) that is not the OS account's home. A harness under
 * a foreign HOME looks for a login keychain that does not exist, and macOS shows a dialog.
 */
export function probeRefusal(env: Env, home?: string): string | null {
  if ((liveHarnessBlocked(process.env) || liveHarnessBlocked(env)) && process.env.JEVRIS_LIVE_HARNESS !== '1' && env.JEVRIS_LIVE_HARNESS !== '1') return 'not probed: test run';
  return foreignHomeRefusal(env, home);
}

/** True for a real harness (or keychain tool) binary name or path; false for a stub such as node. */
export function isTripwireBinary(file: string): boolean {
  return TRIPWIRE_BINARIES.includes(binaryName(file));
}

/**
 * 'not probed: non-default home' when HOME (USERPROFILE on Windows) or the given Jevris home is
 * not the OS account's home, whatever the test flags say; null when it is.
 */
export function foreignHomeRefusal(env: Env, home?: string): string | null {
  const account = accountHome();
  if (account === null) return 'not probed: non-default home';
  const real = realOrSelf(account);
  const envHome = process.platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : env.HOME;
  for (const candidate of [envHome, home]) {
    if (candidate === undefined || candidate === '') continue;
    if (realOrSelf(resolve(candidate)) !== real) return 'not probed: non-default home';
  }
  return null;
}

const live = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pid of live) killTree(pid);
  });
}

/** Kills the process group (POSIX) or the process tree (Windows). A gone process is fine. */
export function killTree(pid: number | undefined): void {
  if (typeof pid !== 'number' || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
    } catch {
      // Nothing more to do.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export interface LaunchOptions {
  readonly cwd?: string;
  readonly env?: { readonly [key: string]: string };
  readonly captureStdout?: boolean;
  /** Also pipe stderr (the trial driver's checks and distilled shell tool). */
  readonly captureStderr?: boolean;
}

export interface LaunchExit {
  /** false when the binary could not be started (missing, not executable, or refused). */
  readonly spawned: boolean;
  readonly code: number | null;
}

export interface Launched {
  readonly pid: number | undefined;
  readonly done: Promise<LaunchExit>;
  readonly stdout: Promise<string>;
  /** Empty unless `captureStderr` was set. */
  readonly stderr: Promise<string>;
  /** Kills the whole tree now. Safe to call more than once. */
  kill(): void;
}

function chunkText(chunk: Uint8Array | string): string {
  if (typeof chunk === 'string') return chunk;
  const Ctor = (globalThis as unknown as { TextDecoder?: new () => { decode(input?: Uint8Array): string } }).TextDecoder;
  return Ctor === undefined ? '' : new Ctor().decode(chunk);
}

function notStarted(): Launched {
  return {
    pid: undefined,
    done: Promise.resolve({ spawned: false, code: null }),
    stdout: Promise.resolve(''),
    stderr: Promise.resolve(''),
    kill: () => {},
  };
}

/**
 * Starts `file` with shell false in its own process group. A refused bare harness name
 * returns a launch that reports `spawned: false` without starting anything.
 */
/**
 * Starts `node <args>` detached and untracked, so it outlives this process (the background
 * re-check, reverify.ts). It runs this Node, never a harness binary; that one is started by
 * the jevris command it runs, through launchTree and its guards. Returns false when it could
 * not start.
 */
export function spawnDetachedNode(args: readonly string[]): boolean {
  try {
    const child = spawn(process.execPath, [...args], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      // Nothing to report to: the caller's marker turns stale and doctor names the fix.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function launchTree(file: string, args: readonly string[], options: LaunchOptions = {}): Launched {
  if (spawnRefused(file)) return notStarted();
  spawnTripwire(file, options.env);
  // PATHEXT resolution; a .cmd or .bat shim runs through cmd.exe /d /s /c with strict
  // escaping, an .exe directly (BLD-06). An unresolvable or unsafe launch is not started.
  const plan = planSpawn(file, args, options.env === undefined ? {} : { env: options.env });
  if (!plan.ok) return notStarted();
  let child;
  try {
    child = spawn(plan.command, [...plan.args], {
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: options.captureStderr === true ? ['ignore', 'pipe', 'pipe'] : options.captureStdout === true ? ['ignore', 'pipe', 'ignore'] : 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch {
    return notStarted();
  }
  const pid = child.pid;
  if (typeof pid === 'number') {
    installExitHook();
    live.add(pid);
  }
  const collect = async (stream: AsyncIterable<Uint8Array | string> | null, wanted: boolean): Promise<string> => {
    if (stream === null || !wanted) return '';
    let text = '';
    try {
      for await (const chunk of stream) text += chunkText(chunk);
    } catch {
      return text;
    }
    return text;
  };
  const stdout = collect(child.stdout, options.captureStdout === true || options.captureStderr === true);
  const stderr = collect(child.stderr, options.captureStderr === true);
  let killed = false;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    killTree(pid);
    if (typeof pid === 'number') live.delete(pid);
  };
  const done = new Promise<LaunchExit>((resolve) => {
    let settled = false;
    const finish = (exit: LaunchExit): void => {
      if (settled) return;
      settled = true;
      // Reap anything the child left behind in its group (MCP servers and the like).
      kill();
      resolve(exit);
    };
    child.on('error', (error) => {
      const code = Reflect.get(error, 'code');
      finish({ spawned: !(code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES'), code: null });
    });
    child.on('exit', (code) => {
      finish({ spawned: true, code });
    });
  });
  return { pid, done, stdout, stderr, kill };
}

export interface BoundedResult {
  readonly stdout: string;
  readonly code: number;
  readonly spawned: boolean;
  readonly timedOut: boolean;
}

/** Runs a short command (for example `--version`), killing the whole tree at `timeoutMs`. */
export async function runBounded(file: string, args: readonly string[], timeoutMs: number): Promise<BoundedResult> {
  const launched = launchTree(file, args, { captureStdout: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    launched.kill();
  }, timeoutMs);
  const exit = await launched.done;
  clearTimeout(timer);
  const stdout = timedOut ? '' : await launched.stdout;
  if (!exit.spawned) return { stdout: '', code: 1, spawned: false, timedOut: false };
  if (timedOut) return { stdout: '', code: 124, spawned: true, timedOut: true };
  return { stdout, code: exit.code ?? 1, spawned: true, timedOut: false };
}

/**
 * Starts a Node child with piped stdio (the installer's MCP and hook smoke, the certify
 * runner). `file` is the Node binary, never a harness name. Shell false, its own process
 * group, and the tree is killed when this process exits. Returns null when it cannot start.
 */
export function spawnPiped(file: string, args: readonly string[], env: { readonly [key: string]: string }): PipedChildProcess | null {
  if (spawnRefused(file)) return null;
  spawnTripwire(file, env);
  let child: PipedChildProcess;
  try {
    child = spawn(file, args, { shell: false, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  } catch {
    return null;
  }
  const pid = child.pid;
  if (typeof pid === 'number') {
    installExitHook();
    live.add(pid);
    child.on('close', () => {
      killTree(pid);
      live.delete(pid);
    });
  }
  return child;
}

export interface CapturedResult {
  readonly spawned: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/**
 * Runs one command with shell false in `cwd`, capturing stdout and stderr, and kills the whole
 * tree at `timeoutMs` or when `signal` aborts. Used by the trial driver for a task's checks and
 * for its harness runs; a refused bare harness name reports `spawned: false`.
 */
export async function runCaptured(
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: { readonly [key: string]: string }; readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<CapturedResult> {
  if (options.signal?.aborted === true) return { spawned: false, code: null, stdout: '', stderr: '', timedOut: false, aborted: true };
  const launched = launchTree(file, args, { cwd: options.cwd, captureStdout: true, captureStderr: true, ...(options.env === undefined ? {} : { env: options.env }) });
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    launched.kill();
  }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    launched.kill();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const exit = await launched.done;
  clearTimeout(timer);
  options.signal?.removeEventListener('abort', onAbort);
  const [stdout, stderr] = await Promise.all([launched.stdout, launched.stderr]);
  return { spawned: exit.spawned, code: exit.code, stdout, stderr, timedOut, aborted };
}

export interface StreamingLaunch {
  readonly pid: number | undefined;
  /** Resolves when the child has exited and its stdout has been fully delivered. */
  readonly done: Promise<LaunchExit>;
  /** The first `STDERR_KEEP` characters of stderr. */
  readonly stderr: Promise<string>;
  /** Kills the whole tree now. Safe to call more than once. */
  kill(): void;
}

const STDERR_KEEP = 4000;
const LINE_CAP = 4 * 1024 * 1024;

/**
 * Starts `file` with shell false in its own process group, writes `input` to its stdin and
 * delivers stdout line by line to `onLine` (an owned Codex session's JSONL events). A line over
 * 4 MiB is dropped, not buffered. Nothing else of stdout is kept. A refused bare harness name
 * or an unresolvable binary reports `spawned: false` without starting anything.
 */
export function launchStreaming(
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: { readonly [key: string]: string }; readonly input: string; readonly onLine: (line: string) => void },
): StreamingLaunch {
  const { send: _send, endInput: _endInput, ...launched } = startStreaming(file, args, options, options.input);
  return launched;
}

/** A streaming launch whose stdin stays open: the caller writes with `send` and closes with `endInput`. */
export interface InteractiveLaunch extends StreamingLaunch {
  /** Writes `text` to stdin; false when stdin is closed or the child was never started. */
  send(text: string): boolean;
  /** Closes stdin. Safe to call more than once. */
  endInput(): void;
}

/**
 * launchStreaming with stdin kept open, for a harness that speaks a request-response protocol
 * on stdio (the Codex app-server's model listing, model-offer.ts). The same guards apply: a
 * refused bare harness name or an unresolvable binary reports `spawned: false`.
 */
export function launchInteractive(
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: { readonly [key: string]: string }; readonly onLine: (line: string) => void },
): InteractiveLaunch {
  return startStreaming(file, args, options, null);
}

function startStreaming(
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: { readonly [key: string]: string }; readonly onLine: (line: string) => void },
  input: string | null,
): InteractiveLaunch {
  const refused: InteractiveLaunch = { pid: undefined, done: Promise.resolve({ spawned: false, code: null }), stderr: Promise.resolve(''), kill: () => {}, send: () => false, endInput: () => {} };
  // Both this process's environment and the child's count: a test cannot unblock a bare name by
  // handing the child a clean environment.
  if (spawnRefused(file) || (options.env !== undefined && spawnRefused(file, options.env))) return refused;
  spawnTripwire(file, options.env);
  const plan = planSpawn(file, args, options.env === undefined ? {} : { env: options.env });
  if (!plan.ok) return refused;
  let child: PipedChildProcess;
  try {
    child = spawn(plan.command, [...plan.args], {
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch {
    return refused;
  }
  const pid = child.pid;
  if (typeof pid === 'number') {
    installExitHook();
    live.add(pid);
  }
  let killed = false;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    killTree(pid);
    if (typeof pid === 'number') live.delete(pid);
  };
  let pending = '';
  let skipping = false;
  const emit = (line: string): void => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.length > 0) options.onLine(text);
  };
  child.stdout?.on('data', (chunk) => {
    const text = chunkText(chunk);
    let start = 0;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', start)) {
      const piece = text.slice(start, at);
      if (!skipping && pending.length + piece.length <= LINE_CAP) emit(pending + piece);
      pending = '';
      skipping = false;
      start = at + 1;
    }
    const rest = text.slice(start);
    if (skipping || pending.length + rest.length > LINE_CAP) {
      pending = '';
      skipping = true;
    } else {
      pending += rest;
    }
  });
  child.stdout?.on('error', () => {});
  let stderrText = '';
  child.stderr?.on('data', (chunk) => {
    if (stderrText.length < STDERR_KEEP) stderrText = (stderrText + chunkText(chunk)).slice(0, STDERR_KEEP);
  });
  child.stderr?.on('error', () => {});
  const done = new Promise<LaunchExit>((resolve) => {
    let settled = false;
    const finish = (exit: LaunchExit): void => {
      if (settled) return;
      settled = true;
      if (!skipping && pending.length > 0) emit(pending);
      pending = '';
      kill();
      resolve(exit);
    };
    child.on('error', (error) => {
      const code = Reflect.get(error, 'code');
      finish({ spawned: !(code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES'), code: null });
    });
    // `close` fires after stdout ends, so every line has been delivered.
    child.on('close', (code) => finish({ spawned: true, code }));
  });
  let inputOpen = true;
  const endInput = (): void => {
    if (!inputOpen) return;
    inputOpen = false;
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
  };
  const send = (text: string): boolean => {
    if (!inputOpen || child.stdin === null || child.stdin === undefined) return false;
    try {
      return child.stdin.write(text) || true;
    } catch {
      return false;
    }
  };
  try {
    child.stdin?.on('error', () => {});
    if (input !== null) {
      inputOpen = false;
      child.stdin?.end(input);
    }
  } catch {
    // A child that closed stdin early still reports through its exit.
  }
  return { pid, done, stderr: done.then(() => stderrText), kill, send, endInput };
}
