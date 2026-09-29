import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jevrisPaths, packsDir } from '@jevris/platform';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { layerIssues, modeMigrationNotice, readEffectiveConfig, readWorkerAuthSettings, testWorkerPortStatus, VENDOR_KEY_VARS, workerAuthMode } from '@jevris/orchestrator';
import { providerOverrideDiagnostic } from '@jevris/provider-typesafe';
import { CERTIFY_ALL, formatDoctor, runDoctor, type DoctorExplain } from './doctor.js';
import { doctorLineSeverity, type DoctorSeverity } from './doctor-severity.js';
import { doctorPrivateLines, privateFileLines, walkPrivate, type LooseEntry } from './private-tighten.js';
import { detectInContainer } from './platform.js';
import { antigravityProducts, antigravityProductsLine } from './antigravity-products.js';
import { hostHealthLines, withHostLines } from './host-health.js';
import { harnessProbeForCli } from './harness-version.js';
import { GLOBAL_HARNESSES, LAUNCHER, claudeGateLine, defaultHarnessCli, installedHarnesses, installedRuntime, renderedClaudeGates, type GlobalHarness, type HarnessCli } from './global-harness.js';
import { runInstallSmoke, type SmokeResult } from './install-smoke.js';
import { probeRefusal } from './live-harness.js';
import { readRuntimeManifest } from './runtime-install.js';
import { refreshHarnessVersions } from './harness-versions.js';
import { CERTIFICATION_FEATURES, coveringCertification, loadCertifications, type CertificationFeature, type CertificationLoad } from './certification-store.js';
import { readLiveEvidence, type LiveEvidence } from './live-evidence.js';
import { parseHarnessManifest } from './harness-manifest.js';
import { maybeReverify, type ReverifyOptions, type ReverifyState } from './reverify.js';
import { managedHookPolicies, managedPolicyLine, type ManagedHookPolicy } from './managed-policy.js';
import { accessLimitsDoctorLines, accessUsageDoctorLines } from './access-limits-doctor.js';
import { jevCircuitDoctorLines } from './jev-circuit-doctor.js';
import { consentDoctorLines } from './consent-command.js';
import { modelAvailabilityDoctorLines, modelAvailabilityView } from './model-availability.js';
import { eligibilityDoctorLines, modelListingLine, modelListingSetting } from './model-offer.js';
import { authLine, authProblem, detectAuth, MODEL_KEYS, type AuthHarness, type HarnessAuthView } from './harness-auth.js';

/**
 * `jevris doctor` (ADM-05, ADM-08): the capability report plus, per harness, whether Jevris
 * is installed there and which signed certification records this machine holds. A version
 * string never certifies anything; only a verified record does (certification-store.ts).
 */

const PACK_BYTE_CAP = 131072;

export interface DoctorCommandInput {
  readonly home: string;
  readonly json: boolean;
  readonly harness?: GlobalHarness;
  readonly values: { readonly [key: string]: string | boolean | undefined };
  readonly root: string;
  readonly cli?: HarnessCli;
  /** Managed hook policy in force (tests); default read from the OS. */
  readonly policies?: readonly ManagedHookPolicy[];
  /** Test seams for the background re-check (reverify.ts). */
  readonly reverifyStart?: ReverifyOptions['start'];
  readonly reverifyGuard?: ReverifyOptions['guard'];
  /** Tests only: the environment the `jevris command` line reads PATH and SHELL from. */
  readonly env?: { readonly [key: string]: string | undefined };
  /** Tests only: the provider.consent.status answer (default: ask a sidecar already running). */
  readonly consentStatus?: () => Promise<unknown>;
  /** Tests only: the status answer the Jev line reads (default: ask a sidecar already running). */
  readonly jevStatus?: () => Promise<unknown>;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => { decode(input?: Uint8Array): string };
  }).TextDecoder;
  if (Ctor === undefined) return undefined;
  try {
    return new Ctor('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function loadPacks(home: string): Promise<readonly unknown[]> {
  const dir = packsDir(jevrisPaths({ home }));
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const packs: unknown[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.includes('/') || name.includes('\\') || name.includes('..')) continue;
    try {
      const bytes = await readFile(join(dir, name));
      const text = bytes.byteLength > PACK_BYTE_CAP ? undefined : decodeUtf8(bytes);
      packs.push(text === undefined ? { schemaVersion: '0' } : (JSON.parse(text) as unknown));
    } catch {
      packs.push({ schemaVersion: '0' });
    }
  }
  return packs;
}

export interface HarnessDoctorRow {
  readonly harness: GlobalHarness;
  readonly installed: boolean;
  readonly version: string | null;
  readonly certificationRecords: number;
  /** Features a verified record covers for this version, OS and time; empty means not certified here. */
  readonly certifiedFeatures: readonly CertificationFeature[];
  /** The single command that certifies this harness on this host. */
  readonly certifyCommand: string;
  /** The installed runtime's MCP handshake and hook fixture for this harness; empty when not installed. */
  readonly smoke: readonly SmokeResult[];
  /** The parity row: each feature this harness does not support, and why (its harness.json). */
  readonly unsupported: readonly { readonly feature: string; readonly reason: string }[];
  /** Installed by an older Jevris (its receipt names no runtime copy): `jevris install` upgrades it. */
  readonly upgrade: boolean;
  /** The record that covers this version: its range, the version it last verified, and when. */
  readonly coverage: { readonly range: string; readonly lastVerified: string | null; readonly verifiedAt: string } | null;
  /** Features the covering record lists as not certified (a failed check or a live demotion). */
  readonly uncertified: readonly { readonly featureId: string; readonly reasonCode: string }[];
  /** The newest record for this harness when none covers this version (it moved out of range). */
  readonly previous: { readonly range: string; readonly lastVerified: string | null; readonly verifiedAt: string } | null;
  /** The background re-check for this version (reverify.ts), when one applies. */
  readonly reverify: ReverifyState | null;
  /** Owned-worker runs whose first-use check passed at this version (live evidence). */
  readonly workerRuns?: number;
}

/** The `unsupported` reasons of every harness manifest in the package, plugins/<harness>/harness.json. */
async function parityRows(root: string): Promise<Partial<Record<GlobalHarness, readonly { feature: string; reason: string }[]>>> {
  const out: Partial<Record<GlobalHarness, readonly { feature: string; reason: string }[]>> = {};
  for (const harness of GLOBAL_HARNESSES) {
    let text: string;
    try {
      text = await readFile(join(root, 'plugins', harness, 'harness.json'), 'utf8');
    } catch {
      continue;
    }
    const manifest = parseHarnessManifest(text, harness).manifest;
    if (manifest !== null) out[harness] = Object.entries(manifest.unsupported).map(([feature, reason]) => ({ feature, reason }));
  }
  return out;
}

/**
 * ADM-05: for each installed harness, the MCP handshake (initialize and tools/list through the
 * installed command) and the harness's hook fixture through the installed launcher, run
 * against the runtime copy its receipt names. Harness binaries are never started.
 */
export const OLDER_INSTALL = 'installed by an older Jevris; run `jevris install` to upgrade';

async function installedSmoke(home: string, dataRoot: string, installed: readonly GlobalHarness[]): Promise<{ readonly smoke: Partial<Record<GlobalHarness, readonly SmokeResult[]>>; readonly older: readonly GlobalHarness[] }> {
  const out: Partial<Record<GlobalHarness, readonly SmokeResult[]>> = {};
  const older: GlobalHarness[] = [];
  const byRuntime = new Map<string, GlobalHarness[]>();
  for (const harness of installed) {
    const runtime = await installedRuntime(dataRoot, harness);
    if (runtime === null) {
      // A receipt without a runtime copy is an install from before the runtime copy existed
      // (the skills-dir plugin, the old Codex hooks.json). `jevris install` upgrades it in place.
      older.push(harness);
      continue;
    }
    byRuntime.set(runtime.dir, [...(byRuntime.get(runtime.dir) ?? []), harness]);
  }
  for (const [runtimeDir, harnesses] of byRuntime) {
    const manifest = await readRuntimeManifest(runtimeDir);
    if (manifest === null) {
      for (const harness of harnesses) out[harness] = [{ harness, check: 'mcp', ok: false, detail: `the runtime copy ${runtimeDir} is missing or damaged; run jevris install again` }];
      continue;
    }
    const results = await runInstallSmoke({ runtimeDir, manifest, harnesses, home });
    for (const harness of harnesses) out[harness] = results.filter((item) => item.harness === 'all' || item.harness === harness).map((item) => ({ ...item, harness }));
  }
  return { smoke: out, older };
}

/** `cert-<harness>-<os>-<version>-<ms>`: the version the record was verified on. */
function verifiedVersion(id: string, harness: string): string | null {
  const match = /^cert-[a-z]+-(?:darwin|linux|win32)-(.+)-\d+$/.exec(id);
  return id.startsWith(`cert-${harness}-`) && match !== null ? (match[1] ?? null) : null;
}

function rangeText(range: { readonly minimum: string; readonly maximumExclusive: string }): string {
  return `>=${range.minimum} <${range.maximumExclusive}`;
}

function harnessRows(
  installed: readonly GlobalHarness[],
  load: CertificationLoad,
  only: GlobalHarness | undefined,
  versions: Partial<Record<GlobalHarness, string>>,
  platform: string,
  nowMs: number,
  parity: Partial<Record<GlobalHarness, readonly { feature: string; reason: string }[]>>,
  smoke: { readonly smoke: Partial<Record<GlobalHarness, readonly SmokeResult[]>>; readonly older: readonly GlobalHarness[] },
  reverify: readonly ReverifyState[] = [],
  evidence: LiveEvidence = { counts: {}, demotions: [] },
): HarnessDoctorRow[] {
  return GLOBAL_HARNESSES.filter((harness) => only === undefined || harness === only).map((harness) => {
    const version = versions[harness] ?? null;
    const covering = CERTIFICATION_FEATURES.map((featureId) => (version === null ? null : coveringCertification(load, { harness, harnessVersion: version, operatingSystem: platform, nowMs, featureId }).covered));
    const certifiedFeatures = CERTIFICATION_FEATURES.filter((_featureId, index) => covering[index] !== null);
    const record = covering.find((item) => item !== null) ?? null;
    const own = load.records.filter((item) => item.record.harness === harness).sort((a, b) => b.record.certifiedAt.localeCompare(a.record.certifiedAt));
    const newest = own[0];
    const summary = (item: CertificationLoad['records'][number]) => ({ range: rangeText(item.record.harnessVersionRange), lastVerified: verifiedVersion(item.record.id, harness), verifiedAt: item.record.certifiedAt.slice(0, 10) });
    return {
      harness,
      installed: installed.includes(harness),
      version,
      certificationRecords: load.records.filter((item) => item.record.harness === harness).length,
      certifiedFeatures,
      certifyCommand: `jevris certify --harness ${LAUNCHER[harness]}`,
      smoke: smoke.smoke[harness] ?? [],
      unsupported: parity[harness] ?? [],
      upgrade: smoke.older.includes(harness),
      coverage: record === null || record === undefined ? null : summary(record),
      uncertified: record === null || record === undefined ? [] : record.record.features.filter((item) => item.status !== 'certified').map((item) => ({ featureId: item.featureId, reasonCode: item.reasonCode ?? 'NOT_CERTIFIED' })),
      previous: (record === null || record === undefined) && newest !== undefined ? summary(newest) : null,
      reverify: reverify.find((item) => item.harness === harness && item.version === version) ?? null,
      workerRuns: version === null ? 0 : (evidence.counts[harness]?.[version]?.['worker.route']?.conforming ?? 0),
    };
  });
}

/**
 * worker.route (owner approval 2026-09-26): certified pending first use, verified in use, or
 * demoted by a first-use check that failed. Null when the harness has no record here at all
 * (its harness line already says what to do).
 */
export function workerLine(row: HarnessDoctorRow): string | null {
  if (!row.installed || row.version === null || row.coverage === null) return null;
  const head = `harness ${row.harness} worker:`;
  const afterFact = row.harness === 'antigravity' ? '; a read-only grant is enforced after the fact (the run is killed), not before' : '';
  const next = rechecking(row) ? RECHECKING : `fix: ${row.certifyCommand}`;
  if (row.certifiedFeatures.includes('worker.route')) {
    const runs = row.workerRuns ?? 0;
    return runs > 0 ? `${head} verified in use (${runs} run${runs === 1 ? '' : 's'} at ${row.version})${afterFact}` : `${head} certified, pending first use (the first owned run checks its init before any tool runs)${afterFact}`;
  }
  const failed = row.uncertified.find((item) => item.featureId === 'worker.route');
  if (failed?.reasonCode === 'LIVE_EVENT_MALFORMED') return `${head} demoted: an owned run's first-use check failed; ${next}`;
  if (failed !== undefined) return `${head} not certified here (${failed.reasonCode}); ${next}`;
  return `${head} not certified yet: the record for ${row.version} predates owned-worker certification; ${next}`;
}

export const RECHECKING = 're-checking in the background, no model call';

function lastVerifiedText(item: { readonly lastVerified: string | null; readonly verifiedAt: string }): string {
  return item.lastVerified === null ? item.verifiedAt : `${item.lastVerified}, ${item.verifiedAt}`;
}

function rechecking(row: HarnessDoctorRow): boolean {
  return row.reverify !== null && (row.reverify.state === 'started' || row.reverify.state === 'running');
}

/**
 * Features whose absence needs nothing from the user (access limits R69), so doctor names them
 * apart, with no fix, and they never make the harness line an action. What is read without them
 * differs by harness:
 * - access.session: on Kilo and OpenCode the plugin's session.error is still read (every session
 *   signal is classified as unproven today). On Claude Code nothing is read from a session: install
 *   registers StopFailure only once access.session is certified for the installed binary
 *   (e5c9697b), and doctor says when the two disagree. Codex has no event to read (unsupported).
 *   Antigravity's error Stop is read through uncertified text patterns (no certify case).
 * - access.detect: an owned run's port reads a limit either way; without the record its class is
 *   not proven for that binary.
 * - access.usage-read (Codex, K21): the listing's usage read still sets a timed usage window
 *   without it, but never lifts one. On Windows it is unsupported
 *   (ACCESS_USAGE_ISOLATION_UNAVAILABLE).
 */
const OPTIONAL_FEATURES: ReadonlySet<string> = new Set(['access.detect', 'access.session', 'access.usage-read']);

function certificationText(row: HarnessDoctorRow): string {
  if (row.certifiedFeatures.length > 0 && row.coverage !== null) {
    const base = `certified for ${row.coverage.range} (last verified ${lastVerifiedText(row.coverage)}): ${row.certifiedFeatures.join(', ')}`;
    const listed = (items: HarnessDoctorRow['uncertified']): string => items.map((item) => `${item.featureId} (${item.reasonCode})`).join(', ');
    const required = row.uncertified.filter((item) => !OPTIONAL_FEATURES.has(item.featureId));
    const optional = row.uncertified.filter((item) => OPTIONAL_FEATURES.has(item.featureId));
    const optionalText = optional.length === 0 ? '' : `; optional, not certified here: ${listed(optional)}`;
    if (required.length === 0) return `${base}${optionalText}`;
    return `${base}; not certified here: ${listed(required)}${optionalText}; ${rechecking(row) ? RECHECKING : `fix: ${row.certifyCommand}`}`;
  }
  if (row.version === null) return row.installed ? `not certified (the ${LAUNCHER[row.harness]} binary was not found; install ${row.harness} or remove Jevris from it with jevris uninstall --harness ${LAUNCHER[row.harness]})` : 'not found on this host';
  if (!row.installed) return `Jevris is not installed there; to add it: jevris install --harness ${LAUNCHER[row.harness]}`;
  if (row.previous !== null) {
    const was = `the record covers ${row.previous.range} (last verified ${lastVerifiedText(row.previous)})`;
    if (rechecking(row)) return `not covered yet: ${row.version} is outside ${was}; ${RECHECKING}`;
    if (row.reverify?.state === 'failed') {
      const failed = row.reverify.failed.map((item) => `${item.featureId} (${item.reasonCode})`).join(', ');
      return `not covered: the background re-check of ${row.version} failed${failed.length > 0 ? ` for ${failed}` : ` (${row.reverify.detail})`}; fix: ${row.certifyCommand}`;
    }
    return `not covered: ${row.version} is outside ${was}${row.reverify?.state === 'refused' ? ` (${row.reverify.detail})` : ''}; fix: ${row.certifyCommand}`;
  }
  return `not certified: no signed record covers this version on this host; fix: ${row.certifyCommand}`;
}

/** One doctor line per harness: installed or not, the version, and its certification. */
export function harnessLine(row: HarnessDoctorRow): string {
  return `harness ${row.harness}: ${row.installed ? 'installed' : 'not installed'}; version ${row.version ?? 'not found'}; certification records: ${row.certificationRecords}; ${certificationText(row)}`;
}

/**
 * The parity lines: by-design limits as information, and Codex's /hooks trust as its own line,
 * because that one needs the user once.
 */
export function parityLines(row: HarnessDoctorRow): string[] {
  const lines: string[] = [];
  const byDesign = row.unsupported.filter((item) => item.feature !== 'hookTrust');
  if (byDesign.length > 0) lines.push(`harness ${row.harness} parity: not available in ${row.harness}, by design: ${byDesign.map((item) => `${item.feature} (${item.reason})`).join('; ')}`);
  const trust = row.unsupported.find((item) => item.feature === 'hookTrust');
  if (trust !== undefined && row.installed) lines.push(`harness ${row.harness} hookTrust: ${trust.reason}`);
  return lines;
}

/** ADM-08: the doctor's harness adapter rows, from the same signed records as the harness lines. */
const ADAPTER_ROWS: Readonly<Partial<Record<GlobalHarness, string>>> = {
  claude: 'claude.adapter',
  codex: 'codex.adapter',
  kilocode: 'kilocode.adapter',
  opencode: 'opencode.adapter',
  antigravity: 'antigravity.adapter',
};

function adapterStatus(rows: readonly HarnessDoctorRow[], load: CertificationLoad, platform: string): { [id: string]: { certified: boolean; reason: string; fixtureHash: string | null } } {
  const out: { [id: string]: { certified: boolean; reason: string; fixtureHash: string | null } } = {};
  for (const row of rows) {
    const id = ADAPTER_ROWS[row.harness];
    if (id === undefined) continue;
    const covering = row.version === null ? null : coveringCertification(load, { harness: row.harness, harnessVersion: row.version, operatingSystem: platform, nowMs: Date.now(), featureId: 'hooks.observe' }).covered;
    out[id] =
      covering === null
        ? { certified: false, reason: `${row.harness}: ${certificationText(row)}.`, fixtureHash: null }
        : { certified: true, reason: `${row.harness} ${row.version ?? ''} is certified for ${row.coverage?.range ?? row.version ?? ''} (${covering.file}); observe hooks run, other actuators follow their own certified features.`, fixtureHash: covering.record.fixtureSuiteHash };
  }
  return out;
}

/** The worker.route actuator row, from the harness rows' own worker.route coverage. */
function workerActuator(rows: readonly HarnessDoctorRow[]): { certified: boolean; reason: string; fixtureHash: string | null } {
  const certified = rows.filter((row) => row.installed && row.certifiedFeatures.includes('worker.route'));
  if (certified.length > 0) {
    const names = certified.map((row) => `${row.harness} ${row.version ?? ''}`.trim()).join(', ');
    return { certified: true, reason: `owned workers are certified on ${names}; each harness's worker line says whether a run has verified it in use.`, fixtureHash: null };
  }
  return { certified: false, reason: `worker.route is not certified: no signed record covers an owned worker here; fix: ${CERTIFY_ALL} (no model call)`, fixtureHash: null };
}

/**
 * The top block from the harness rows (item 9): full, certified and passed once every installed
 * harness is certified for its version here and passed its smoke; otherwise why, and the fix.
 */
export function topBlock(rows: readonly HarnessDoctorRow[], environmentUnsupported: boolean): { readonly full: boolean; readonly explain: DoctorExplain } {
  const installed = rows.filter((row) => row.installed);
  const names = (list: readonly HarnessDoctorRow[]) => list.map((row) => `${row.harness}${row.version === null ? '' : ` ${row.version}`}`).join(', ');
  const older = installed.filter((row) => row.upgrade);
  const broken = installed.filter((row) => !row.upgrade && row.smoke.some((item) => !item.ok));
  const waiting = installed.filter((row) => rechecking(row));
  const uncertified = installed.filter((row) => row.certifiedFeatures.length === 0 && !rechecking(row));
  if (installed.length === 0) {
    const fix = 'no harness has Jevris installed; fix: jevris install';
    return { full: false, explain: { harnessProbe: fix, eventProbe: fix, installStatus: fix } };
  }
  const full = !environmentUnsupported && older.length === 0 && broken.length === 0 && uncertified.length === 0 && waiting.length === 0;
  if (full) {
    const ranges = installed.map((row) => `${row.harness} ${row.coverage?.range ?? row.version ?? ''}`.trim()).join(', ');
    return { full, explain: { harnessProbe: `every installed harness is certified for its version range: ${ranges}`, installStatus: 'every installed harness is certified for its version range and passed its smoke' } };
  }
  const needInstall = older.length > 0 || broken.length > 0;
  const fixes = [...(needInstall ? ['jevris install'] : []), ...(uncertified.length > 0 ? [CERTIFY_ALL] : [])];
  const fix = fixes.length === 0 ? 'nothing to do: doctor shows the result' : `fix: ${fixes.join(', then ')}`;
  const why = [
    ...(older.length > 0 ? [`installed by an older Jevris: ${names(older)}`] : []),
    ...(broken.length > 0 ? [`the installed smoke failed: ${names(broken)}`] : []),
    ...(uncertified.length > 0 ? [`no signed record for this version here: ${names(uncertified)}`] : []),
    ...(waiting.length > 0 ? [`${RECHECKING}: ${names(waiting)}`] : []),
  ];
  const onlyWaiting = uncertified.length === 0 && waiting.length > 0;
  const explain: DoctorExplain = {
    ...(uncertified.length > 0 ? { harnessProbe: `no signed record covers ${names(uncertified)} on this host yet; fix: ${CERTIFY_ALL}` } : {}),
    ...(uncertified.length > 0 ? { eventProbe: `no live hook event has been checked for ${names(uncertified)} on this host yet; fix: ${CERTIFY_ALL}` } : {}),
    ...(onlyWaiting ? { harnessProbe: `${RECHECKING}: ${names(waiting)}; nothing to do: doctor shows the result` } : {}),
    ...(onlyWaiting ? { eventProbe: `${RECHECKING}: ${names(waiting)}; nothing to do: doctor shows the result` } : {}),
    installStatus: environmentUnsupported ? 'the harness version could not be read or this environment is not supported, so Jevris runs rules-only' : `hooks observe and advise, and actuation waits (${why.join('; ')}); ${fix}`,
  };
  return { full, explain };
}

/** The owned-worker harness behind each installed harness. */
const AUTH_HARNESS: Readonly<Partial<Record<GlobalHarness, AuthHarness>>> = { claude: 'claude', codex: 'codex', kilocode: 'kilo', opencode: 'opencode', antigravity: 'antigravity' };

/**
 * Per-harness auth mode (owner decision 2026-09-26): D's effective mode from workers.json and
 * the environment, with what the harness itself reports. Names and modes only, never a value.
 */
export async function authViews(
  home: string,
  cli: HarnessCli,
  only: GlobalHarness | undefined,
  env: { readonly [key: string]: string | undefined } = process.env,
  guard: (env: { readonly [key: string]: string | undefined }, home: string) => string | null = probeRefusal,
): Promise<{ readonly views: readonly HarnessAuthView[]; readonly settingsProblem: string | null }> {
  const settings = readWorkerAuthSettings(jevrisPaths({ home }).config);
  // Never ask a harness in a test run or under a HOME that is not the account's: a harness under
  // a foreign HOME looks for a login keychain that does not exist, and macOS shows a dialog.
  const refusal = guard(env, home);
  const stated = settings.ok ? settings.auth : {};
  const views: HarnessAuthView[] = [];
  for (const harness of GLOBAL_HARNESSES) {
    const worker = AUTH_HARNESS[harness];
    if (worker === undefined || (only !== undefined && harness !== only)) continue;
    const setting = stated[worker] ?? 'auto';
    const mode = workerAuthMode(worker, setting, env);
    const keyVars = VENDOR_KEY_VARS[worker];
    const keysInEnvironment = keyVars.filter((name) => (env[name] ?? '') !== '');
    const modelKeysInEnvironment = MODEL_KEYS[worker].filter((name) => (env[name] ?? '') !== '');
    const detected = refusal === null ? await detectAuth(worker, cli, env, () => null) : 'not-probed';
    views.push({ harness: worker, setting, mode, keysInEnvironment, ...(modelKeysInEnvironment.length === 0 ? {} : { modelKeysInEnvironment }), detected, problem: authProblem(worker, mode, keyVars, keysInEnvironment, detected, env), ...(refusal === null ? {} : { notProbed: refusal }) });
  }
  return { views, settingsProblem: settings.ok ? null : settings.problem };
}

/**
 * The running sidecar against the runtime installed here: a line only when it runs another
 * (older) build, which a reinstall of the same version does not replace until it restarts.
 */
export function sidecarBuildLine(view: { readonly state: string; readonly pid: number | null; readonly build?: { readonly running: string | null; readonly installed: string; readonly verificationRuns: number } }): string | null {
  const build = view.build;
  if (view.state !== 'running' || build === undefined || build.running === build.installed) return null;
  const which = `running ${build.running ?? 'a build from before build ids'}, installed ${build.installed}`;
  const runs = build.verificationRuns > 0 ? `; it restarts by itself once its ${build.verificationRuns === 1 ? 'verification run ends' : `${build.verificationRuns} verification runs end`}` : '';
  return `sidecar build: the sidecar${view.pid === null ? '' : ` (pid ${view.pid})`} runs an older build than the installed runtime (${which})${runs}; fix: jevris sidecar restart`;
}

/** IPC-16: one line with what the sidecar reports, or why it is degraded. */
export function sidecarLine(view: { readonly state: string; readonly degraded: boolean; readonly pid: number | null; readonly version: string | null; readonly uptimeMs: number | null; readonly endpoint: string | null; readonly store: { readonly state: string; readonly diagnostic: string | null } | null; readonly killSwitch: string; readonly message: string }): string {
  if (view.state !== 'running') return `sidecar: ${view.state}${view.degraded ? ' (degraded)' : ''}; kill switch ${view.killSwitch}. ${view.message}`;
  const facts = [
    `pid ${view.pid ?? 'unknown'}`,
    `version ${view.version ?? 'unknown'}`,
    `up ${view.uptimeMs === null ? 'unknown' : `${Math.round(view.uptimeMs / 1000)} s`}`,
    `endpoint ${view.endpoint ?? 'unknown'}`,
  ];
  const store = view.store === null ? 'unknown' : `${view.store.state}${view.store.diagnostic === null ? '' : ` (${view.store.diagnostic})`}`;
  return `sidecar: running${view.degraded ? ' (degraded)' : ''}; ${facts.join(', ')}; store ${store}; kill switch ${view.killSwitch}`;
}

export async function runDoctorCommand(input: DoctorCommandInput, write: (text: string) => void): Promise<number> {
  const platform = typeof input.values.platform === 'string' ? input.values.platform : process.platform;
  const nodeVersion = typeof input.values['node-version'] === 'string' ? input.values['node-version'] : process.version;
  const harnessFlag = input.values['harness-version'];
  const versions = await refreshHarnessVersions(input.home, input.harness === undefined ? GLOBAL_HARNESSES : [input.harness], input.cli ?? defaultHarnessCli);
  const dataRoot = jevrisPaths({ home: input.home }).data;
  const installed = await installedHarnesses(dataRoot);
  const load = await loadCertifications(input.home, { root: input.root });
  const smoke = await installedSmoke(input.home, dataRoot, installed.filter((harness) => input.harness === undefined || harness === input.harness));
  // Owner direction 2026-09-26: a version outside its record's range, or a feature a live event
  // demoted, is re-checked in the background (at most once per version; never in a test run or
  // under a foreign HOME). Observation and advice go on meanwhile.
  const reverify = await maybeReverify({ home: input.home, root: input.root, installed, versions, platform, load, ...(input.reverifyStart === undefined ? {} : { start: input.reverifyStart }), ...(input.reverifyGuard === undefined ? {} : { guard: input.reverifyGuard }) });
  const rows = harnessRows(installed, load, input.harness, versions, platform, Date.now(), await parityRows(input.root), smoke, reverify, await readLiveEvidence(input.home));
  const policies = (input.policies ?? (await managedHookPolicies({ platform }))).filter((item) => input.harness === undefined || item.harness === input.harness);
  // Antigravity is three products with one plugin root; name each one found (AGY-01, ADM-05).
  const showAntigravity = input.harness === undefined || input.harness === 'antigravity';
  const agyProducts = antigravityProducts({ platform, home: input.home });
  const agyCli = (input.cli ?? defaultHarnessCli).available('agy');
  // IPC-16: the sidecar's pid, version, uptime, endpoint, store health and kill switch; never starts it.
  const { sidecarDoctorView } = await import('./runtime-commands.js');
  const sidecar = await sidecarDoctorView(input.home);
  const auth = await authViews(input.home, input.cli ?? defaultHarnessCli, input.harness);
  // E's `jevris egress status` (the transport guard's own decision): an approval shows as allow,
  // and a denial names its fix.
  const egress = await egressStatus(input.home, input.env ?? process.env);
  const probed = await runDoctor({
    ...(egress?.egress === 'approved' ? { setting: { provenance: 'administrator', sourceEgress: 'approved-scoped' } } : {}),
    platform,
    nodeVersion,
    env: process.env,
    // IPC-19: the same container detector the sidecar uses (tests inject inContainer instead).
    inContainer: await detectInContainer({ platform, env: process.env }),
    packs: await loadPacks(input.home),
    certificationRecords: [],
    fixtureHashes: {},
    // The version line is Claude Code's: the flag, else the version just read, else the reader.
    versionProbe: typeof harnessFlag !== 'string' && versions.claude !== undefined ? () => versions.claude ?? null : harnessProbeForCli(typeof harnessFlag === 'string' ? harnessFlag : undefined),
    workspace: { home: input.home, root: typeof input.values.workspace === 'string' ? input.values.workspace : process.cwd() },
    adapterStatus: { ...adapterStatus(rows, load, platform), 'worker.route': workerActuator(rows) },
  });
  // The top block follows the signed records: full, certified and passed once every installed
  // harness is certified for its version here and passed its smoke; otherwise why and the fix.
  // Without Claude Code the legacy version line is unknown; the harness rows decide instead.
  const top = topBlock(rows, probed.environmentStatus === 'unsupported' && !rows.some((row) => row.installed && row.version !== null));
  const report = top.full ? { ...probed, installStatus: 'full' as const, harnessProbe: { ...probed.harnessProbe, health: 'certified' as const, eventProbe: 'passed' as const, actuators: 'certified' as const } } : probed;
  const workersFile = join(jevrisPaths({ home: input.home }).config, 'workers.json');
  const lines: string[] = [sidecarLine(sidecar)];
  const buildLine = sidecarBuildLine(sidecar);
  if (buildLine !== null) lines.push(buildLine);
  // The `jevris` command: on PATH, which one runs, or the line to add (command-launcher.ts).
  const commandLine = await jevrisCommandLine(input.home, dataRoot, installed.length > 0, input.env ?? process.env);
  if (commandLine !== null) lines.push(commandLine);
  for (const row of rows) lines.push(harnessLine(row));
  const listingSetting = await modelListingSetting(input.home, input.env);
  for (const row of rows) {
    if (row.upgrade) lines.push(`harness ${row.harness} install: ${OLDER_INSTALL}`);
    // B's LOW 31: a gated Claude event registered without a certifying record, or certified but not registered.
    const gateLine = row.harness === 'claude' && row.installed ? claudeGateLine(await renderedClaudeGates(input.home), row.certifiedFeatures, row.version) : null;
    if (gateLine !== null) lines.push(gateLine);
    for (const item of row.smoke) lines.push(`harness ${row.harness} ${item.check === 'mcp' ? 'mcp handshake' : 'hook fixture'}: ${item.ok ? 'ok' : 'failed'} (${item.detail})`);
    lines.push(...parityLines(row));
    const worker = workerLine(row);
    if (worker !== null) lines.push(worker);
    // DOMAINS 3f090fa: whether this harness's models come from its own listing or from runs.
    if (row.installed) lines.push(modelListingLine(row, listingSetting));
  }
  if (showAntigravity) {
    const agyRow = rows.find((row) => row.harness === 'antigravity');
    lines.push(antigravityProductsLine(agyProducts, { found: agyCli || (agyRow?.version ?? null) !== null, version: agyRow?.version ?? null, certified: (agyRow?.certifiedFeatures.length ?? 0) > 0, ...(agyRow?.coverage == null ? {} : { range: agyRow.coverage.range }) }));
  }
  // Auth matters only where a harness is on this machine: installed, found, or asked about.
  const onHost = (worker: AuthHarness): boolean => {
    const row = rows.find((item) => AUTH_HARNESS[item.harness] === worker);
    return input.harness !== undefined || (row !== undefined && (row.installed || row.version !== null));
  };
  for (const view of auth.views) if (onHost(view.harness)) lines.push(authLine(view, workersFile));
  // C's account eligibility (8b4b851, DOMAINS 3f090fa): per installed harness and the sign-in its
  // owned workers use, what routing may choose there; every model with --harness.
  const scopes = rows.filter((row) => row.installed).flatMap((row) => {
    const view = auth.views.find((item) => item.harness === AUTH_HARNESS[row.harness]);
    return view === undefined ? [] : [{ harness: row.harness, authMode: view.mode }];
  });
  lines.push(...(await eligibilityDoctorLines(input.home, scopes, input.harness !== undefined)));
  if (auth.settingsProblem !== null) lines.push(`workers.json: ${auth.settingsProblem}; owned workers are refused until it is fixed`);
  for (const policy of policies) lines.push(managedPolicyLine(policy));
  // The effective mode and the layer that set it, and any problem with a file that caps it
  // (51fb3122: host.json, organization.json, the managed policy, the workspace file).
  const settings = settingsView(input.home, typeof input.values.workspace === 'string' ? input.values.workspace : null);
  lines.push(...settings.lines);
  for (const bad of load.rejected) lines.push(`certification ${bad.file}: rejected (${bad.reasonCode}); fix: jevris certify --harness all`);
  // C's found-gone record (f5b19ab), added by E for F: the models the router leaves out on this machine.
  lines.push(...modelAvailabilityDoctorLines(await modelAvailabilityView(input.home)));
  // Access limits (gap 5): each pause in force, read-only from the machine record, as route limits lists it.
  lines.push(...(await accessLimitsDoctorLines(input.home, Date.now())));
  // OP-6: the last Codex usage reading per sign-in (bands only), read-only from core's kept readings.
  lines.push(...(await accessUsageDoctorLines(input.home, Date.now())));
  // Jev disabled after a billing, account or key refusal (ea2af91a): from a running sidecar's status only.
  lines.push(...(await jevCircuitDoctorLines(input.home, input.jevStatus)));
  // R30: which registry routing reads (the administrator override shows), and consent per provider.
  lines.push(...(await consentDoctorLines(input.home, input.consentStatus)));
  // B's private-file rule: every entry under the Jevris folders, not only the top level.
  const loose: readonly LooseEntry[] = process.platform === 'win32' ? [] : await walkPrivate({ home: input.home, repair: false });
  const host = await hostHealthLines({ home: input.home });
  const hostLines = process.platform === 'win32' ? await doctorPrivateLines(input.home, host) : replacePrivateLines(host, privateFileLines(input.home, loose));
  const formatted = withEgressFix(formatDoctor(report, undefined, undefined, top.explain), egress?.reasonCode ?? null);
  // formatDoctor may already print the override line; it must appear exactly once.
  const override = providerOverrideDiagnostic(process.env);
  if (override !== null && !formatted.split('\n').includes(override)) lines.unshift(override);
  // While the scripted test worker port is active (or asked for and refused), doctor says so.
  const testWorker = testWorkerPortStatus(process.env, input.home).diagnostic;
  if (testWorker !== null && !formatted.split('\n').includes(testWorker)) lines.unshift(testWorker);
  const text = withHostLines(formatted, [...lines, ...hostLines]);
  if (input.json) {
    write(
      `${JSON.stringify({
        report,
        providerOverride: providerOverrideDiagnostic(process.env),
        testWorkerPort: testWorkerPortStatus(process.env, input.home).diagnostic,
        sidecar,
        harnesses: rows,
        auth: auth.views,
        ...(auth.settingsProblem === null ? {} : { authSettingsProblem: auth.settingsProblem }),
        ...(showAntigravity ? { antigravityProducts: agyProducts } : {}),
        managedPolicies: policies,
        settings: settings.json,
        certifications: {
          dir: load.dir,
          records: load.records.map((item) => ({ file: item.file, harness: item.record.harness, trust: item.trust, expiresAt: item.record.expiresAt })),
          rejected: load.rejected,
        },
        // The release gate reads these: the top block, every line with its severity, and the
        // Jevris entries other users can read.
        summary: { installStatus: report.installStatus, harnessProbe: report.harnessProbe.health, eventProbe: report.harnessProbe.eventProbe },
        lines: doctorLines(text),
        privateFiles: { loose: loose.map((entry) => ({ path: entry.path, kind: entry.kind, mode: entry.mode })) },
      })}\n`,
    );
    return COMMAND_EXIT_CODES.ok;
  }
  write(text);
  return COMMAND_EXIT_CODES.ok;
}

/** What each settings issue code means and how to fix it (doctor's `settings issue` lines). */
function settingsIssueFix(code: string, path = ''): string {
  // SR-20: your own jevris.config.json is there but cannot be used.
  if (path === 'user:') return 'your jevris.config.json cannot be used, so the mode is capped at observe; fix it by hand, or run jevris configure set mode off (or observe) to write a fresh one';
  if (code === 'AUTHORITY_FILE_NOT_OWNER' || code === 'AUTHORITY_FILE_SHARED_WRITE') return 'its ceiling still applies, but it grants nothing; make the file yours and owner-only (chmod 600)';
  if (code === 'AUTHORITY_FILE_IN_WORK_TREE' || code === 'JEVRIS_HOME_IN_WORK_TREE') return 'its ceiling still applies, but it grants nothing; keep the Jevris home outside any git repository';
  if (code === 'AUTHORITY_FILE_SYMLINK' || code === 'AUTHORITY_FILE_NOT_REGULAR') return 'it is not read, so the mode is capped at observe; replace it with a regular file';
  if (code.startsWith('MANAGED_')) return 'the managed policy is refused, so the mode is capped at observe; ask your administrator';
  if (code === 'NOT_NARROWABLE' || code === 'INVALID_VALUE') return 'that key is ignored; a workspace file may only lower the keys settings.md lists';
  return 'it is not used, so the mode is capped at observe; fix the file to match the host-policy contract';
}

const MODE_SET_BY: { readonly [source: string]: string } = {
  defaults: 'the defaults',
  user: 'your jevris.config.json',
  workspace: "the workspace's .jevris/config.json",
  organization: 'organization.json (a ceiling)',
  host: 'host.json (a ceiling)',
  managed: 'the managed policy (a ceiling)',
};

/** Doctor's settings lines: the effective mode and its source, and each narrowing layer's issue. */
function settingsView(home: string, workspaceRoot: string | null): { readonly lines: readonly string[]; readonly json: unknown } {
  try {
    const eff = readEffectiveConfig({ home, workspaceRoot });
    const issues = layerIssues(eff.issues);
    const notice = modeMigrationNotice({ home });
    return {
      lines: [
        `settings mode: ${eff.config.mode} (set by ${MODE_SET_BY[eff.modeSource] ?? eff.modeSource})`,
        ...(notice === null ? [] : [`settings notice: ${notice}`]),
        ...issues.map((issue) => `settings issue: ${issue.path} ${issue.code}; ${settingsIssueFix(issue.code, issue.path)}`),
      ],
      json: { mode: eff.config.mode, modeSource: eff.modeSource, issues, ...(notice === null ? {} : { notice }) },
    };
  } catch {
    return { lines: ['settings issue: the settings could not be read; run jevris configure'], json: null };
  }
}

interface EgressStatusView {
  readonly egress: string;
  readonly reasonCode: string | null;
}

/** `jevris egress status --json` for this home; the Jev key is never read here. Null when it cannot run. */
async function egressStatus(home: string, env: { readonly [key: string]: string | undefined }): Promise<EgressStatusView | null> {
  try {
    const { runEgressCommand } = await import('./egress-command.js');
    let out = '';
    const code = await runEgressCommand(['status', '--json', '--home', home], (text) => (out += text), {
      env,
      openKeyring: () => {
        throw new Error('doctor does not read the Jev key');
      },
    });
    if (code !== 0) return null;
    const parsed = JSON.parse(out) as { egress?: unknown; reasonCode?: unknown };
    return { egress: String(parsed.egress), reasonCode: typeof parsed.reasonCode === 'string' ? parsed.reasonCode : null };
  } catch {
    return null;
  }
}

/** Denials only an administrator or a file fix can lift: `jevris egress status` says which. */
const EGRESS_POLICY_DENIALS = new Set([
  'MANAGED_POLICY_DENIES',
  'MANAGED_POLICY_REFUSED',
  'ORGANIZATION_DENIES',
  'HOST_POLICY_INVALID',
  // SR-4: a policy file that breaks the authority-file rules approves nothing.
  'AUTHORITY_FILE_SYMLINK',
  'AUTHORITY_FILE_NOT_REGULAR',
  'AUTHORITY_FILE_NOT_OWNER',
  'AUTHORITY_FILE_SHARED_WRITE',
  'AUTHORITY_FILE_IN_WORK_TREE',
  'JEVRIS_HOME_IN_WORK_TREE',
]);

/** The egressReasonCode line with its fix. Denial is by design, so the line stays info. */
export function withEgressFix(text: string, statusReason: string | null): string {
  const fix =
    statusReason !== null && EGRESS_POLICY_DENIALS.has(statusReason)
      ? `nothing leaves this machine: ${statusReason}; jevris egress status shows why`
      : 'nothing leaves this machine until you approve it; fix: run jevris egress approve (interactive)';
  return text
    .split('\n')
    .map((line) => (line.startsWith('egressReasonCode: ') && !line.includes(' (') ? `${line} (${fix})` : line))
    .join('\n');
}

async function jevrisCommandLine(home: string, dataRoot: string, installed: boolean, env: { readonly [key: string]: string | undefined }): Promise<string | null> {
  const { commandDoctorLine } = await import('./command-launcher.js');
  const { resolve } = await import('node:path');
  return commandDoctorLine({ home: resolve(home), dataRoot, platform: process.platform, env }, installed);
}

/** The host lines with their privateFiles lines replaced by `mine`, in the same place. */
function replacePrivateLines(host: readonly string[], mine: readonly string[]): string[] {
  const out: string[] = [];
  let placed = false;
  for (const line of host) {
    if (!line.startsWith('privateFiles: ')) out.push(line);
    else if (!placed) {
      out.push(...mine);
      placed = true;
    }
  }
  if (!placed) out.push(...mine);
  return out;
}

/** Each printed doctor line (the JEVRIS_REPORT line excluded) with its severity. */
export function doctorLines(text: string): { readonly text: string; readonly severity: DoctorSeverity | null }[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('JEVRIS_REPORT '))
    .map((line) => ({ text: line, severity: doctorLineSeverity(line) }));
}
