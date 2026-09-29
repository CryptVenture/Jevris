import { runBounded } from './live-harness.js';
import type { DoctorReport } from '@jevris/contracts';

/**
 * Probes the installed claude binary. A version string is not certification.
 * eventProbe stays did-not-pass. Actuators stay unsupported.
 * shell is false. argv is an array. No hooks subcommand. No hook manifest.
 */

const DEFAULT_BINARY = 'claude';
const TIMEOUT_MS = 2000;
const DOTTED_VERSION = /^\d+(?:\.\d+)+$/;

export type InstalledHarnessProbe = DoctorReport['harnessProbe'];

export interface HarnessProbeOptions {
  readonly shell: false;
  readonly timeout: number;
}

export interface HarnessProbeSpawnResult {
  readonly stdout: string;
  readonly code?: number;
  readonly spawned?: boolean;
  readonly timedOut?: boolean;
}

export type HarnessProbeRunner = (
  file: string,
  args: readonly string[],
  options: HarnessProbeOptions,
) => Promise<HarnessProbeSpawnResult>;

export interface ProbeInstalledHarnessInput {
  readonly harnessRunner?: HarnessProbeRunner;
}

interface ProbeStep {
  readonly stdout: string;
  readonly code: number;
  readonly timedOut: boolean;
}

let defaultRunner: HarnessProbeRunner | undefined;

export function setDefaultHarnessProbeRunner(runner: HarnessProbeRunner | undefined): void {
  defaultRunner = runner;
}

/** Default runner: whole-tree kill on timeout; refuses a PATH lookup under tests (live-harness.ts). */
async function nodeProbeRunner(
  file: string,
  args: readonly string[],
  options: HarnessProbeOptions,
): Promise<HarnessProbeSpawnResult> {
  const result = await runBounded(file, args, options.timeout);
  if (!result.spawned) return { stdout: '', code: 1, spawned: false };
  if (result.timedOut) return { stdout: '', code: 124, spawned: true, timedOut: true };
  return { stdout: result.stdout, code: result.code, spawned: true };
}

function dottedToken(stdout: string): string | null {
  const token = stdout.trim().split(/\s+/)[0];
  if (token === undefined || token.length === 0) return null;
  if (!DOTTED_VERSION.test(token)) return null;
  return token;
}

function unsupported(binaryPresent: boolean, versionToken: string | null): InstalledHarnessProbe {
  return {
    health: 'unsupported',
    eventProbe: 'did-not-pass',
    actuators: 'unsupported',
    binaryPresent,
    versionToken,
  };
}

async function runStep(
  runner: HarnessProbeRunner,
  args: readonly string[],
): Promise<ProbeStep | 'missing'> {
  try {
    const result = await runner(DEFAULT_BINARY, args, { shell: false, timeout: TIMEOUT_MS });
    if (result.spawned === false) return 'missing';
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      code: typeof result.code === 'number' ? result.code : 0,
      timedOut: result.timedOut === true,
    };
  } catch {
    return 'missing';
  }
}

function stepFailed(step: ProbeStep): boolean {
  return step.timedOut || step.code !== 0;
}

export async function probeInstalledHarness(
  input: ProbeInstalledHarnessInput = {},
): Promise<InstalledHarnessProbe> {
  const runner = input.harnessRunner ?? defaultRunner ?? nodeProbeRunner;
  const version = await runStep(runner, ['--version']);
  if (version === 'missing') return unsupported(false, null);
  const versionToken = dottedToken(version.stdout);
  if (version.timedOut) return unsupported(true, versionToken);
  const doctor = await runStep(runner, ['doctor']);
  if (doctor === 'missing' || doctor.timedOut || stepFailed(version) || stepFailed(doctor) || versionToken === null) {
    return unsupported(true, versionToken);
  }
  return {
    health: 'installation-only',
    eventProbe: 'did-not-pass',
    actuators: 'unsupported',
    binaryPresent: true,
    versionToken,
  };
}
