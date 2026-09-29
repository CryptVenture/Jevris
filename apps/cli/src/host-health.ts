import { readdir } from 'node:fs/promises';
import {
  assertOwnerOnly,
  BETTER_SQLITE3,
  jevrisPaths,
  legacyLeftovers,
  machineIdentity,
  pathApiFor,
  probeNativeAddon,
  type JevrisPaths,
  type MachineIdentityResult,
  type NativeProbe,
  type OwnerOnlyOptions,
} from '@jevris/platform';
import { probeKeyringBinding, type KeyringBindingStatus } from './credential.js';

/**
 * Host health lines for doctor (BLD-08, BLD-13). They are plain lines printed before the
 * JEVRIS_REPORT line; the report contract does not change.
 *
 * - `nativeAddon better-sqlite3: loaded | unavailable (<CODE>)`
 * - `nativeAddon keyring: loaded | unavailable | not-probed`
 * - `privateFiles: ok` or one `privateFiles: wide <path> <detail>` line per finding
 * - `legacyLayout: none` or one `legacyLayout: leftover <path>` line per leftover
 * - `storeIdentity: machine id` or `storeIdentity: host name (<reason>) ...` (DATA-10): what the
 *   store's host scope is derived from. The host-name fallback follows the network name.
 */

export interface HostHealthOptions {
  readonly home: string;
  readonly platform?: string;
  readonly probeSqlite?: () => NativeProbe;
  readonly probeKeyring?: () => Promise<KeyringBindingStatus>;
  readonly ownerOnly?: OwnerOnlyOptions;
  readonly listDir?: (path: string) => Promise<readonly string[]>;
  readonly machine?: () => MachineIdentityResult;
}

/** DATA-10: what the store's host scope comes from; never the id itself. */
export function storeIdentityLine(identity: MachineIdentityResult): string {
  if (identity.ok) return 'storeIdentity: machine id (stable across network name changes)';
  return `storeIdentity: host name (${identity.reason}); the machine id could not be read, so a network name change can make the store look copied. \`jevris store adopt\` re-marks your own store if that happens`;
}

export function sqliteProbe(): NativeProbe {
  return probeNativeAddon(BETTER_SQLITE3, { from: import.meta.url });
}

/** The Jevris directories and the files directly inside data and config. */
export async function privateTargets(paths: JevrisPaths, listDir: (path: string) => Promise<readonly string[]>): Promise<readonly string[]> {
  const api = pathApiFor(paths.platform);
  const dirs = [paths.config, paths.data, paths.state, paths.runtime];
  const out: string[] = [];
  for (const dir of dirs) {
    if (!out.includes(dir)) out.push(dir);
  }
  for (const dir of [paths.config, paths.data]) {
    let names: readonly string[];
    try {
      names = await listDir(dir);
    } catch {
      continue;
    }
    for (const name of [...names].sort()) {
      const full = api.join(dir, name);
      if (!out.includes(full)) out.push(full);
    }
  }
  return out;
}

export async function hostHealthLines(options: HostHealthOptions): Promise<readonly string[]> {
  const lines: string[] = [];
  const sqlite = (options.probeSqlite ?? sqliteProbe)();
  lines.push(sqlite.ok ? 'nativeAddon better-sqlite3: loaded' : `nativeAddon better-sqlite3: unavailable (${sqlite.code})`);
  if (!sqlite.ok) lines.push(sqlite.diagnostic);
  lines.push(`nativeAddon keyring: ${await (options.probeKeyring ?? probeKeyringBinding)()}`);

  const paths = jevrisPaths({ home: options.home, ...(options.platform === undefined ? {} : { platform: options.platform }) });
  const ownerOnly: OwnerOnlyOptions = { platform: paths.platform, ...options.ownerOnly };
  const wide: string[] = [];
  for (const target of await privateTargets(paths, options.listDir ?? readdir)) {
    const check = await assertOwnerOnly(target, ownerOnly);
    if (check.ok || check.reason === 'missing') continue;
    wide.push(`privateFiles: wide ${target} ${check.detail}`);
  }
  if (wide.length === 0) lines.push('privateFiles: ok');
  else lines.push(...wide);

  let leftovers: readonly string[] = [];
  try {
    leftovers = await legacyLeftovers(paths);
  } catch {
    leftovers = [];
  }
  if (leftovers.length === 0) lines.push('legacyLayout: none');
  for (const path of leftovers) lines.push(`legacyLayout: leftover ${path}`);
  lines.push(storeIdentityLine((options.machine ?? machineIdentity)()));
  return lines;
}

/** Inserts host lines before the JEVRIS_REPORT line of a formatted doctor report. */
export function withHostLines(doctorText: string, lines: readonly string[]): string {
  if (lines.length === 0) return doctorText;
  const marker = '\nJEVRIS_REPORT ';
  const at = doctorText.indexOf(marker);
  if (at < 0) return doctorText;
  return `${doctorText.slice(0, at)}\n${lines.join('\n')}${doctorText.slice(at)}`;
}
