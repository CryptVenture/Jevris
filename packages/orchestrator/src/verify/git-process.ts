/**
 * One git process, run to its end (the spawn half of `nodeGit`, VER-03).
 *
 * `runGitSelfContained` is a plain function of its arguments with no reference to anything outside it, so the same
 * text runs on the thread that calls `runGitProcess` (the CLI, a test, a sidecar whose git workers are not up) and, as
 * source, in the git worker threads of `git-work.ts`. Process creation is a blocking call of the thread that makes it
 * (on Windows `CreateProcess` runs inside `spawn`, and a loaded runner took hundreds of milliseconds to seconds for it),
 * so the sidecar makes it off its event loop.
 */
import { spawn } from 'node:child_process';
import { resolveExecutable } from '@jevris/platform';

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  /** git's own message, when the port captured it (for reporting a git failure). */
  readonly stderr?: string;
}

/** Everything one git run needs, as plain data: it is sent to a git worker thread as is. */
export interface GitRequest {
  /** The program to run; null means `git`, found on PATH (see `findGit`). */
  readonly command: string | null;
  /** Arguments before `-c core.quotepath=off` (a test seam runs `node script.js` as a stand-in git). */
  readonly prefixArgs: readonly string[];
  readonly args: readonly string[];
  readonly cwd: string;
  /** The whole environment of the process. */
  readonly env: { readonly [key: string]: string | undefined };
  readonly timeoutMs: number;
}

/** The environment git runs under: no prompts, no optional locks, and only the variables it needs. */
export function gitEnv(): { readonly [key: string]: string | undefined } {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG'];
  const env: { [key: string]: string | undefined } = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/**
 * git without a shell: resolves when git exits, and a call past `timeoutMs` kills git and resolves not ok. It never
 * rejects. It uses only its arguments and the globals every thread has, because `GIT_RUNNER_SOURCE` (its own text) is
 * what the git worker threads run: keep every constant and helper inside it.
 */
function runGitSelfContained(
  spawnProcess: typeof spawn,
  request: GitRequest,
  program: string,
): Promise<GitResult> {
  // The most git output kept; more fails the call (as spawnSync's maxBuffer did).
  const maxBuffer = 256 * 1024 * 1024;
  // The most of git's own message kept.
  const errKeep = 1024 * 1024;
  const decode = (chunks: readonly Uint8Array[], total: number): string => {
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      if (at + chunk.length > total) break;
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return new TextDecoder().decode(bytes.subarray(0, at));
  };
  return new Promise<GitResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnProcess(program, [...request.prefixArgs, '-c', 'core.quotepath=off', ...request.args], { shell: false, windowsHide: true, cwd: request.cwd, env: request.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, stdout: '', stderr: '' });
      return;
    }
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let failed = false;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: ok && !failed, stdout: decode(out, outBytes), stderr: decode(err, Math.min(errBytes, errKeep)) });
    };
    const stop = (): void => {
      failed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      stop();
      finish(false);
    }, request.timeoutMs);
    child.stdout?.on('data', (chunk: Uint8Array) => {
      outBytes += chunk.length;
      if (outBytes > maxBuffer) stop();
      else out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Uint8Array) => {
      if (errBytes + chunk.length <= errKeep) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on('error', () => finish(false));
    child.on('close', (code: number | null) => finish(code === 0));
  });
}

/** The text of `runGitSelfContained`, for the git worker threads (they run it with their own `spawn`). */
export const GIT_RUNNER_SOURCE: string = runGitSelfContained.toString();

const foundByPath = new Map<string, string>();

/**
 * `git` found on the PATH of `env`, or the bare name when it is not (the spawn then fails as it always did). Searching PATH is
 * file system work (a run of stat calls, many on Windows, where every PATHEXT name is tried in every folder), so a program that was
 * found is remembered for that PATH value.
 */
export function findGit(env: { readonly [key: string]: string | undefined } = process.env): string {
  const path = env['PATH'] ?? env['Path'] ?? '';
  const known = foundByPath.get(path);
  if (known !== undefined) return known;
  const found = resolveExecutable('git', { env });
  if (found === null) return 'git';
  foundByPath.set(path, found);
  return found;
}

/** One git run in the calling thread. `program` is the program once found, so a caller that runs git several times searches PATH once. */
export function runGitProcess(request: GitRequest, program: string = request.command ?? findGit(request.env)): Promise<GitResult> {
  return runGitSelfContained(spawn, request, program);
}
