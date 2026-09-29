import type { HarnessId } from '@jevris/contracts';
import { LAUNCHER, type GlobalHarness, type HarnessCli } from './global-harness.js';

/**
 * Installed harness versions (HCF-02). `<binary> --version` is read once per install, doctor
 * and certify run and written to the host ledger (`harness-versions`, D's recordHarnessVersion),
 * which the sidecar reads with harnessVersionOf before it lets a record certify a feature.
 * The launcher never spawns a harness to find its version.
 */

const SEMVER_IN_TEXT = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;

/** The first x.y.z token in `--version` output ("2.1.280 (Claude Code)" gives "2.1.280"). */
export function versionFromOutput(text: string): string | null {
  const match = SEMVER_IN_TEXT.exec(text);
  if (match === null) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ?? ''}`;
}

/** The exclusive upper bound of a certification record: the next minor version. */
export function nextMinor(version: string): string {
  const match = SEMVER_IN_TEXT.exec(version);
  if (match === null) return '0.0.1';
  return `${Number(match[1])}.${Number(match[2]) + 1}.0`;
}

/**
 * How far a certification carries past the version it verified (each harness.json declares one):
 * - same-minor: up to the next minor (2.1.282 covers 2.1.282 and later 2.1.x);
 * - same-major: up to the next major;
 * - exact: that patch release only.
 * A version outside the range is re-checked in the background (reverify.ts).
 */
export type CompatibilityRule = 'exact' | 'same-minor' | 'same-major';
export const COMPATIBILITY_RULES: readonly CompatibilityRule[] = ['exact', 'same-minor', 'same-major'];

/** The exclusive upper bound a record verified on `version` gets under `rule`. */
export function versionBound(version: string, rule: CompatibilityRule): string {
  const match = SEMVER_IN_TEXT.exec(version);
  if (match === null) return '0.0.1';
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (rule === 'same-major') return `${major + 1}.0.0`;
  if (rule === 'exact') return `${major}.${minor}.${patch + 1}`;
  return `${major}.${minor + 1}.0`;
}

export async function probeHarnessVersion(
  harness: GlobalHarness,
  cli: HarnessCli,
  env?: { readonly [key: string]: string | undefined },
): Promise<string | null> {
  const bin = LAUNCHER[harness];
  if (!cli.available(bin)) return null;
  const ran = await cli.run(bin, ['--version'], 10_000, env);
  if (!ran.spawned || ran.code !== 0) return null;
  return versionFromOutput(ran.stdout);
}

/** Writes the version to the host ledger. Never throws: a missing ledger only loses the hint. */
export async function recordVersion(home: string, harness: GlobalHarness, version: string): Promise<boolean> {
  try {
    const { recordHarnessVersion } = await import('@jevris/orchestrator');
    await recordHarnessVersion(home, harness as HarnessId, version);
    return true;
  } catch {
    return false;
  }
}

/** Probes and records every given harness that is on PATH. Returns what it found. */
export async function refreshHarnessVersions(
  home: string,
  harnesses: readonly GlobalHarness[],
  cli: HarnessCli,
  env?: { readonly [key: string]: string | undefined },
): Promise<Partial<Record<GlobalHarness, string>>> {
  const found: Partial<Record<GlobalHarness, string>> = {};
  for (const harness of harnesses) {
    const version = await probeHarnessVersion(harness, cli, env);
    if (version === null) continue;
    found[harness] = version;
    await recordVersion(home, harness, version);
  }
  return found;
}
