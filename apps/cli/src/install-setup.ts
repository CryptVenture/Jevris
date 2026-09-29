/**
 * What `jevris install` does after a successful install (owner directive 2026-09-26, "the
 * setup you just made me do manually should be automatic at install"):
 *
 * 1. Certifies every harness it installed, exactly as `jevris certify --harness all` does (no
 *    model call, each in a throwaway profile). A harness that does not certify never fails the
 *    install: its line names the reason and the fix. `--no-certify` skips this.
 * 2. Reads each harness's sign-in mode the way doctor does (never a key or token). Where
 *    nothing is detectable and nothing is stated, an interactive terminal is asked once per
 *    harness, and the answer goes to `<config>/workers.json`, which always overrides detection.
 *
 * Every test-time guard stays: certify refuses the real harness binaries in a test run unless
 * JEVRIS_LIVE_HARNESS=1, and a harness is never asked about its login in a test run or under a
 * HOME that is not the account's (doctor's probe rule).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jevrisPaths, writePrivateFile } from '@jevris/platform';
import { WORKERS_SETTINGS_FILE, WORKERS_SETTINGS_SCHEMA } from '@jevris/orchestrator';
import { certifyHarness, type CertifyResult } from './certification.js';
import type { GlobalHarness, HarnessCli } from './global-harness.js';
import { authLine, type AuthHarness, type AuthMode } from './harness-auth.js';
import { authViews } from './doctor-cli.js';

export interface InstallCertification {
  readonly harness: GlobalHarness;
  readonly ok: boolean;
  readonly harnessVersion: string | null;
  /** Why it is not certified (certify's error, or the failed features with their reason codes). */
  readonly reason: string | null;
}

/** Certifies each installed harness in turn; never throws. */
export async function certifyInstalled(options: {
  readonly home: string;
  readonly root: string;
  readonly harnesses: readonly GlobalHarness[];
  readonly cli?: HarnessCli;
}): Promise<readonly InstallCertification[]> {
  const out: InstallCertification[] = [];
  for (const harness of options.harnesses) {
    let result: CertifyResult;
    try {
      result = await certifyHarness({ home: options.home, harness, json: false, root: options.root, ...(options.cli === undefined ? {} : { cli: options.cli }) });
    } catch (error) {
      out.push({ harness, ok: false, harnessVersion: null, reason: `certify failed: ${String((error as { message?: unknown }).message ?? error).slice(0, 200)}` });
      continue;
    }
    const failed = result.features.filter((item) => !item.passed).map((item) => `${item.featureId} (${item.reasonCode ?? 'failed'})`);
    const reason = result.ok ? null : (result.error !== null && failed.length === 0 ? result.error : failed.length > 0 ? `not certified: ${failed.join(', ')}` : (result.error ?? 'not certified'));
    out.push({ harness, ok: result.ok, harnessVersion: result.harnessVersion, reason });
  }
  return out;
}

/** One line per harness, then the mode line that replaces install's "mode: reduced". */
export function certificationLines(results: readonly InstallCertification[]): string[] {
  const lines = results.map((item) =>
    item.ok
      ? `certify ${item.harness}: certified${item.harnessVersion === null ? '' : ` (version ${item.harnessVersion})`}`
      : `certify ${item.harness}: ${item.reason ?? 'not certified'}; fix: jevris certify --harness ${item.harness}`,
  );
  const waiting = results.filter((item) => !item.ok).map((item) => item.harness);
  lines.push(
    waiting.length === 0
      ? 'mode: certified (hooks act on their certified features; jevris doctor shows each harness)'
      : `mode: reduced for ${waiting.join(', ')} (observe only until certified; the lines above name the fix)`,
  );
  return lines;
}

/** Owned-worker harnesses behind the installed ones (the doctor's mapping). */
const AUTH_OF: Readonly<Partial<Record<GlobalHarness, AuthHarness>>> = { claude: 'claude', codex: 'codex', kilocode: 'kilo', opencode: 'opencode', antigravity: 'antigravity' };

/**
 * Sets one harness's mode in workers.json, keeping everything else in the file. A file that is
 * not a valid workers.json is left alone (doctor names its problem). Returns whether it wrote.
 */
export async function recordWorkerAuth(configDir: string, harness: AuthHarness, mode: AuthMode): Promise<boolean> {
  const path = join(configDir, WORKERS_SETTINGS_FILE);
  let current: Record<string, unknown> = { schemaVersion: WORKERS_SETTINGS_SCHEMA };
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { schemaVersion?: unknown }).schemaVersion !== WORKERS_SETTINGS_SCHEMA) return false;
    current = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') return false;
  }
  const auth = current['auth'];
  if (auth !== undefined && (auth === null || typeof auth !== 'object' || Array.isArray(auth))) return false;
  const next = { ...current, auth: { ...(auth as Record<string, unknown> | undefined), [harness]: mode } };
  const written = await writePrivateFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return written.ok;
}

/**
 * Asks once per installed harness whose sign-in doctor would show as unknown, and records the
 * answer. `ask` returns the typed answer; anything but subscription or api-key skips it.
 */
export async function askUnknownAuth(options: {
  readonly home: string;
  readonly harnesses: readonly GlobalHarness[];
  readonly cli: HarnessCli;
  readonly ask: (question: string) => Promise<string>;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly guard?: Parameters<typeof authViews>[4];
}): Promise<string[]> {
  const lines: string[] = [];
  const wanted = new Set(options.harnesses.map((harness) => AUTH_OF[harness]).filter((item): item is AuthHarness => item !== undefined));
  const { views, settingsProblem } = await authViews(options.home, options.cli, undefined, options.env ?? process.env, ...(options.guard === undefined ? [] : [options.guard]));
  if (settingsProblem !== null) return lines;
  const config = jevrisPaths({ home: options.home }).config;
  for (const view of views) {
    if (!wanted.has(view.harness) || !authLine(view).startsWith(`harness ${view.harness} auth: unknown`)) continue;
    const answer = (await options.ask(`How does ${view.harness} sign in for Jevris's owned workers? [s]ubscription, [a]pi-key, or Enter to skip: `)).trim().toLowerCase();
    const mode: AuthMode | null = /^s(ubscription)?$/.test(answer) ? 'subscription' : /^a(pi-?key)?$/.test(answer) ? 'api-key' : null;
    if (mode === null) {
      lines.push(`auth ${view.harness}: skipped; state it in ${join(config, WORKERS_SETTINGS_FILE)} when you know`);
      continue;
    }
    lines.push((await recordWorkerAuth(config, view.harness, mode)) ? `auth ${view.harness}: ${mode} (recorded in ${join(config, WORKERS_SETTINGS_FILE)})` : `auth ${view.harness}: not recorded; ${WORKERS_SETTINGS_FILE} is not one Jevris can update`);
  }
  return lines;
}
