/**
 * Runs one planned process without a shell, with a real timeout, bounded capture and a
 * whole-tree kill (POSIX process group; `taskkill /T` on Windows). The raw output hash covers
 * every byte even when the kept copy is truncated.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { planSpawn } from '@jevris/platform';

export const DEFAULT_CAPTURE_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;

export interface ExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: { readonly [key: string]: string };
  readonly timeoutMs: number;
  readonly platform?: string;
  readonly captureBytes?: number;
  readonly signal?: AbortSignal;
  /**
   * POSIX: the file-mode mask the process starts with (`checkUmask()` for a verification check).
   * Absent: it inherits this process's mask, which in the sidecar is the private 077.
   */
  readonly umask?: number;
}

export interface ExecResult {
  readonly ok: boolean;
  readonly spawned: boolean;
  readonly reason: 'exited' | 'not-found' | 'unsafe-argument' | 'invalid' | 'spawn-error' | 'timeout' | 'aborted';
  readonly resolved: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly combinedHash: string;
  readonly truncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The sidecar's own mask on POSIX: every file it creates starts owner-only. */
const PRIVATE_UMASK = 0o077;
/** The mask a check runs under when the launching shell's mask is unknown: the common default. */
export const DEFAULT_CHECK_UMASK = 0o022;

function readUmask(): number | null {
  try {
    // Reading means setting: the restrictive value is in place for the instant between.
    const current = process.umask(PRIVATE_UMASK);
    process.umask(current);
    return current;
  } catch {
    return null; // a worker thread cannot read or change the mask
  }
}

// The mask this process was started with, read when the module loads. The sidecar's entry
// point sets the private 077 at startup; a load after that sees 077, which is not the user's.
let launchUmask: number | null = (() => {
  if (process.platform === 'win32') return null;
  const mask = readUmask();
  return mask === null || mask === PRIVATE_UMASK ? null : mask;
})();

/** The entry point records the mask it replaced with 077, so checks keep the user's own mask. */
export function recordLaunchUmask(mask: number): void {
  if (Number.isInteger(mask) && mask >= 0 && mask <= 0o777 && mask !== PRIVATE_UMASK) launchUmask = mask;
}

/**
 * The mask a verification check runs under (POSIX): the launching shell's mask when known,
 * else 022. A check never inherits the sidecar's private 077, so it behaves as it does when the
 * developer runs the same command in a shell (a receipt is evidence about that command).
 */
export function checkUmask(): number {
  return launchUmask ?? DEFAULT_CHECK_UMASK;
}

/** Runs `start` with the process mask set to `mask`, restoring it at once (spawn forks synchronously). */
function withUmask<T>(mask: number | undefined, platform: string, start: () => T): T {
  if (mask === undefined || platform === 'win32') return start();
  let previous: number | null = null;
  try {
    previous = process.umask(mask);
  } catch {
    previous = null; // a worker thread: the child inherits the current mask
  }
  try {
    return start();
  } finally {
    if (previous !== null) process.umask(previous);
  }
}

export function killTree(child: ChildProcess, platform: string, signal: string): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000 });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export function runProcess(request: ExecRequest): Promise<ExecResult> {
  const platform = request.platform ?? process.platform;
  const cap = request.captureBytes ?? DEFAULT_CAPTURE_BYTES;
  const startedAtMs = Date.now();
  const empty = new Uint8Array(0);
  const plan = planSpawn(request.command, request.args, { platform, env: request.env, cwd: request.cwd });
  if (!plan.ok) {
    return Promise.resolve({
      ok: false,
      spawned: false,
      reason: plan.reason,
      resolved: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      startedAtMs,
      endedAtMs: Date.now(),
      stdout: empty,
      stderr: empty,
      combinedHash: createHash('sha256').update('').digest('hex'),
      truncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
  }
  return new Promise<ExecResult>((resolve) => {
    const hash = createHash('sha256');
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let kept = 0;
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = withUmask(request.umask, platform, () =>
        spawn(plan.command, plan.args, {
          cwd: request.cwd,
          env: request.env,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
          detached: platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch {
      resolve({
        ok: false,
        spawned: false,
        reason: 'spawn-error',
        resolved: plan.resolved,
        exitCode: null,
        signal: null,
        timedOut: false,
        startedAtMs,
        endedAtMs: Date.now(),
        stdout: empty,
        stderr: empty,
        combinedHash: hash.digest('hex'),
        truncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
      });
      return;
    }
    const keep = (target: Uint8Array[], chunk: Uint8Array) => {
      hash.update(chunk);
      if (kept >= cap) {
        truncated = true;
        return;
      }
      const room = cap - kept;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      target.push(piece);
      kept += piece.length;
    };
    child.stdout?.on('data', (chunk) => {
      outBytes += chunk.length;
      keep(out, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      errBytes += chunk.length;
      keep(err, chunk);
    });
    let hardKill: unknown;
    const stop = () => {
      killTree(child, platform, 'SIGTERM');
      hardKill = setTimeout(() => killTree(child, platform, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null, sig: string | null, spawnFailed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill !== undefined) clearTimeout(hardKill);
      request.signal?.removeEventListener('abort', onAbort);
      const outTotal = out.reduce((n, c) => n + c.length, 0);
      const errTotal = err.reduce((n, c) => n + c.length, 0);
      const reason: ExecResult['reason'] = spawnFailed ? 'spawn-error' : timedOut ? 'timeout' : aborted ? 'aborted' : 'exited';
      resolve({
        ok: !spawnFailed && !timedOut && !aborted && code === 0 && sig === null,
        spawned: !spawnFailed,
        reason,
        resolved: plan.resolved,
        exitCode: code,
        signal: sig,
        timedOut,
        startedAtMs,
        endedAtMs: Date.now(),
        stdout: concat(out, outTotal),
        stderr: concat(err, errTotal),
        combinedHash: hash.digest('hex'),
        truncated,
        stdoutBytes: outBytes,
        stderrBytes: errBytes,
      });
    };
    child.on('error', () => finish(null, null, true));
    child.on('close', (code, sig) => finish(code, sig, false));
  });
}
