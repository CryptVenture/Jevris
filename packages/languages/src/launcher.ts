import { planSpawn, type ResolveOptions, type SpawnPlan } from '@jevris/platform';

/**
 * Argv plan for a trusted absolute command and one path argument.
 * A path with spaces stays one element. This module does not start a process
 * and does not write a record.
 */

export interface LauncherPlan {
  readonly argv: readonly [string, string];
  readonly shell: false;
  /** How the process would start on this OS: direct, or cmd.exe for a .cmd/.bat shim (BLD-06). */
  readonly spawn: SpawnPlan;
}

export function buildLauncherPlan(command: string, pathArgument: string, options: ResolveOptions = {}): LauncherPlan {
  const argv: readonly [string, string] = [command, pathArgument];
  return { argv, shell: false, spawn: planSpawn(command, [pathArgument], options) };
}
