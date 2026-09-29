import { runBounded } from './live-harness.js';

/**
 * Reads the installed harness version. The command and argv are fixed.
 * shell is false. A missing binary, non-zero exit, timeout, empty stdout,
 * or a non-dotted token returns null. stderr is discarded.
 */

const COMMAND = 'claude';
const VERSION_FLAG = '--version';
const TIMEOUT_MS = 2000;
const DOTTED_VERSION = /^\d+(?:\.\d+)+$/;

export interface ExecFileOptions {
  readonly shell: false;
  readonly timeout: number;
}

export interface ExecFileResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code?: number;
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<ExecFileResult>;

export interface HarnessVersionDeps {
  readonly execFile?: ExecFileFn;
}

let defaultExecFile: ExecFileFn | undefined;

export function setDefaultHarnessExecFile(execFile: ExecFileFn | undefined): void {
  defaultExecFile = execFile;
}

/** Default runner: whole-tree kill on timeout; refuses a PATH lookup under tests (live-harness.ts). */
async function nodeExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<ExecFileResult> {
  const result = await runBounded(file, args, options.timeout);
  return result.spawned && !result.timedOut && result.code === 0 ? { stdout: result.stdout, code: 0 } : { stdout: '', code: 1 };
}

function dottedToken(stdout: string): string | null {
  const token = stdout.trim().split(/\s+/)[0];
  if (token === undefined || token.length === 0) return null;
  if (!DOTTED_VERSION.test(token)) return null;
  return token;
}

export async function readInstalledHarnessVersion(deps?: HarnessVersionDeps): Promise<string | null> {
  const execFile = deps?.execFile ?? defaultExecFile ?? nodeExecFile;
  try {
    const result = await execFile(COMMAND, [VERSION_FLAG], { shell: false, timeout: TIMEOUT_MS });
    if (typeof result.code === 'number' && result.code !== 0) return null;
    if (typeof result.stdout !== 'string') return null;
    return dottedToken(result.stdout);
  } catch {
    return null;
  }
}

export function harnessProbeForCli(
  flag?: string,
  read: () => Promise<string | null> = readInstalledHarnessVersion,
): () => Promise<string | null> {
  if (flag === undefined || flag === '') return read;
  return () => Promise.resolve(flag);
}
