/// <reference path="../types/installer.d.ts" />
import { antigravityCertifyHint, antigravityProducts } from './antigravity-products.js';
import { confineOutputPath, writeConfinedOutput, type OutputPathRefusal } from './host-policy.js';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMAND_EXIT_CODES,
  CertificationRecordContract,
  EMAIL_PATTERN,
  ID_PATTERN,
  LISTING_EVIDENCE_PATHS_MAX,
  LISTING_EVIDENCE_PATH_CHARS,
  LISTING_EVIDENCE_PATH_PATTERN,
  PUBLIC_COMMAND_NAMES,
  REASON_CODE_PATTERN,
  SECRET_PATTERNS,
  STUB_CASE_EVIDENCE_MAX,
  STUB_TRACE_MAX,
  STUB_TRACE_NAME_PATTERN,
  URL_PATTERNS,
  ReleaseEvidenceContract,
  releaseEvidence,
  signRecord,
  type CertificationRecord,
} from '@jevris/contracts';
import { jevrisPaths, writePrivateFile } from '@jevris/platform';
import {
  CLAUDE_MARKETPLACE_REL,
  CLAUDE_PLUGIN_ID,
  GLOBAL_HARNESSES,
  LAUNCHER,
  defaultHarnessCli,
  installGlobal,
  installedHarnesses,
  type GlobalHarness,
  type HarnessCli,
  type HookCertification,
  type OperationReport,
} from './global-harness.js';
import { accountHome, liveHarnessAllowed, launchTree } from './live-harness.js';
import { managedHookPolicies, managedPolicyLine, type ManagedHookPolicy } from './managed-policy.js';
import { MODEL_SIGNAL_CASES, modelSignalRows } from './model-signal-capture.js';
import { loadModelSignalCapture } from './model-signals.js';
import { modelListCheck, type ModelListCheck, type RawListing, type RawListingInput } from './model-offer.js';
import { probeHarnessVersion, recordVersion, versionBound, type CompatibilityRule } from './harness-versions.js';
import { parseHarnessManifest } from './harness-manifest.js';
import { finishReverify, isReverifyMarker, reverifyDir } from './reverify.js';
import { workerLimitations, workerRouteCheck } from './worker-certify.js';
import { accessDetectCaseIds, ACCESS_SESSION_CASES, runStubCases, stubCaseLines, type AccessCaseHarness, type StubCaseContext, type StubCaseResult, type StubTraceEntry } from './stub-cases.js';
import { readRuntimeManifest, runtimeEntry, type RuntimeManifest } from './runtime-install.js';
import { USAGE_READ_CASE_ID } from './usage-read-case.js';
import { ACCESS_USAGE_ISOLATION_UNAVAILABLE } from '@jevris/contracts';
import { adapterCapabilities, adapterCases, fixtureSuiteHash, launcherCases, mergeCases, type ConformanceCase } from './conformance-run.js';
import {
  CERTIFICATION_FEATURES,
  certificationsDir,
  coveringCertification,
  loadCertifications,
  localSigningKey,
  type CertificationFeature,
} from './certification-store.js';

/**
 * `jevris certify --harness <name>` (HCF-01, HCF-02): certifies one harness on this machine
 * against its REAL binary, in a throwaway profile, and records the result.
 *
 * 1. Reads `<binary> --version` (the binary on PATH).
 * 2. Installs Jevris into a temp profile (HOME, USERPROFILE, XDG_*, CODEX_HOME all inside it),
 *    with the installer's own post-install smoke.
 * 3. Asks the real binary, inside that profile, whether it sees the plugin, the MCP server and
 *    the skills; for Kilo and OpenCode it also proves the plugin module is loaded and called
 *    (`serve` on 127.0.0.1, one session, no prompt, so no model call).
 * 4. Runs the nine §15.4 conformance cases against the installed runtime.
 * 5. Writes a signed CertificationRecord to `<data>/certifications/` and two release-evidence
 *    files (`harness-conformance`, `certification-record`) to `--evidence <dir>`, default
 *    `<data>/evidence`.
 *
 * It never runs under the test suite's live-harness block, never touches the real harness
 * configuration, and removes the temp profile (and every child it started) at the end.
 */

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

const DAY_MS = 86_400_000;
const VALIDITY_DAYS = 30;
const RUN_TIMEOUT_MS = 60_000;
type Env = { readonly [key: string]: string | undefined };

export { nextMinor, probeHarnessVersion, versionFromOutput } from './harness-versions.js';

/**
 * Whether a verified record certifies a feature of a harness (its observe hooks unless named) at
 * its installed version, on this OS, now. Used by install to decide whether Antigravity's hook
 * group starts enabled and which gated Claude events it registers.
 */
export function certifiedHooks(home: string, cli: HarnessCli = defaultHarnessCli): HookCertification {
  return async (harness, featureId = 'hooks.observe') => {
    if (cli === defaultHarnessCli && !liveHarnessAllowed()) return false;
    const load = await loadCertifications(home);
    if (!load.records.some((item) => item.record.harness === harness)) return false;
    const version = await probeHarnessVersion(harness, cli);
    if (version === null) return false;
    const coverage = coveringCertification(load, {
      harness,
      harnessVersion: version,
      operatingSystem: process.platform,
      nowMs: Date.now(),
      featureId,
    });
    return coverage.covered !== null;
  };
}

/** HOME, USERPROFILE, the XDG folders and CODEX_HOME all point into the profile. */
/** Variables that point a harness at another config; the temp profile never inherits them. */
const PROFILE_OVERRIDES = new Set([
  'CLAUDE_CONFIG_DIR',
  'KILO_CONFIG',
  'KILO_CONFIG_DIR',
  'KILO_CONFIG_CONTENT',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'GEMINI_CLI_HOME',
]);

export function isolatedEnv(profile: string, base: Env = process.env): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(base)) if (typeof value === 'string' && !PROFILE_OVERRIDES.has(key)) env[key] = value;
  Object.assign(env, {
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(profile, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(profile, '.config'),
    XDG_DATA_HOME: join(profile, '.local', 'share'),
    XDG_STATE_HOME: join(profile, '.local', 'state'),
    XDG_CACHE_HOME: join(profile, '.cache'),
    CODEX_HOME: join(profile, '.codex'),
    JEVRIS_HOME: profile,
    JEVRIS_HOOK_OBSERVE_ONLY: '1',
  });
  return env;
}

/**
 * The environment certify runs a harness with, and the HOME the installer gives its CLI.
 *
 * On macOS, Claude Code reads its login with /usr/bin/security, which finds the login keychain
 * through HOME: under a temp HOME macOS shows "A keychain cannot be found" (the owner saw it).
 * So on macOS Claude Code keeps the account's own HOME, and only its config folder moves into
 * the throwaway profile (CLAUDE_CONFIG_DIR: settings, plugins, .claude.json). Nothing is
 * written to ~/.claude, and no model is called (checked live on 2.1.283).
 *
 * Codex keeps the temp HOME: it reads its plugin marketplace from $HOME/.agents, so the
 * account HOME would show it the user's own plugins (a live run did). Kilo, OpenCode and
 * Antigravity keep the temp HOME too (Antigravity must never touch ~/.gemini).
 */
export function certifyEnv(
  harness: GlobalHarness,
  profile: string,
  base: Env = process.env,
  platform: string = process.platform,
  account: string | null = accountHome(),
): { readonly env: { [key: string]: string }; readonly harnessHome: string | null } {
  const env = isolatedEnv(profile, base);
  if (harness !== 'claude') return { env, harnessHome: null };
  // Claude Code's config folder is named on every OS, so it never depends on HOME.
  env['CLAUDE_CONFIG_DIR'] = join(profile, '.claude');
  if (platform !== 'darwin' || account === null) return { env, harnessHome: null };
  env['HOME'] = account;
  env['USERPROFILE'] = account;
  return { env, harnessHome: account };
}

export interface FeatureCheck {
  readonly featureId: CertificationFeature;
  readonly passed: boolean;
  readonly reasonCode: string | null;
  readonly detail: string;
}

interface LiveContext {
  readonly harness: GlobalHarness;
  readonly cli: HarnessCli;
  readonly env: { readonly [key: string]: string };
  readonly profile: string;
  readonly install: OperationReport;
}

function feature(featureId: CertificationFeature, passed: boolean, reasonCode: string, detail: string): FeatureCheck {
  return { featureId, passed, reasonCode: passed ? null : reasonCode, detail };
}

async function sees(ctx: LiveContext, args: readonly string[], needle: RegExp): Promise<{ ok: boolean; detail: string }> {
  const ran = await ctx.cli.run(LAUNCHER[ctx.harness], args, RUN_TIMEOUT_MS, ctx.env);
  if (!ran.spawned) return { ok: false, detail: `${args.join(' ')}: not started` };
  if (ran.code !== 0) return { ok: false, detail: `${args.join(' ')}: exit ${ran.code}` };
  return { ok: needle.test(ran.stdout), detail: `${args.join(' ')}: ${needle.test(ran.stdout) ? 'sees jevris' : 'jevris not listed'}` };
}

/**
 * `claude plugin details jevris@jevris-local` prints the plugin's component inventory
 * (code.claude.com/docs/en/plugins/cli-reference, read 27 September 2026). Certified only when
 * every public command's skill is named there as a word (G17: the check used to match
 * "status" alone, so seven missing skills still passed).
 */
async function claudeSkillsListed(ctx: LiveContext): Promise<{ ok: boolean; detail: string }> {
  const args = ['plugin', 'details', CLAUDE_PLUGIN_ID];
  const ran = await ctx.cli.run(LAUNCHER[ctx.harness], args, RUN_TIMEOUT_MS, ctx.env);
  if (!ran.spawned) return { ok: false, detail: `${args.join(' ')}: not started` };
  if (ran.code !== 0) return { ok: false, detail: `${args.join(' ')}: exit ${ran.code}` };
  const missing = PUBLIC_COMMAND_NAMES.filter((name) => !new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`).test(ran.stdout));
  return missing.length === 0
    ? { ok: true, detail: `${args.join(' ')}: all ${PUBLIC_COMMAND_NAMES.length} skills listed` }
    : { ok: false, detail: `${args.join(' ')}: missing ${missing.join(', ')}` };
}

/**
 * `<harness> debug skill` (Kilo, OpenCode) prints the discovered skills as JSON. Certified
 * only when every public command's jevris-<name> skill is there exactly once (SKL-02/03).
 */
async function skillsDiscovered(ctx: LiveContext): Promise<{ ok: boolean; detail: string }> {
  const ran = await ctx.cli.run(LAUNCHER[ctx.harness], ['debug', 'skill'], RUN_TIMEOUT_MS, ctx.env);
  if (!ran.spawned) return { ok: false, detail: 'debug skill: not started' };
  if (ran.code !== 0) return { ok: false, detail: `debug skill: exit ${ran.code}` };
  const at = ran.stdout.indexOf('[');
  let list: unknown;
  try {
    list = JSON.parse(at < 0 ? '' : ran.stdout.slice(at));
  } catch {
    return { ok: false, detail: 'debug skill: output is not a JSON list' };
  }
  if (!Array.isArray(list)) return { ok: false, detail: 'debug skill: output is not a JSON list' };
  const names = list.map((item) => (item !== null && typeof item === 'object' ? (item as { name?: unknown }).name : undefined)).filter((name): name is string => typeof name === 'string');
  const ours = names.filter((name) => name.startsWith('jevris-'));
  const expected = PUBLIC_COMMAND_NAMES.map((name) => `jevris-${name}`);
  const missing = expected.filter((name) => !ours.includes(name));
  const duplicated = ours.length !== new Set(ours).size;
  const unprefixed = names.filter((name) => (PUBLIC_COMMAND_NAMES as readonly string[]).includes(name));
  const ok = missing.length === 0 && !duplicated && unprefixed.length === 0 && ours.length === expected.length;
  const problems = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    duplicated ? 'a Jevris skill is listed twice' : '',
    unprefixed.length > 0 ? `unprefixed ${unprefixed.join(', ')} (a Claude or v1 copy is visible)` : '',
  ].filter((item) => item.length > 0);
  return { ok, detail: ok ? `debug skill: all ${expected.length} jevris-* skills, once each` : `debug skill: ${problems.join('; ')}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kilo and OpenCode: instruments the temp profile's copy of the shim with a marker write,
 * starts `serve` on 127.0.0.1, creates one session (no prompt, no model call) and checks that
 * the module was imported and its plugin function called.
 */
async function pluginLoads(ctx: LiveContext): Promise<{ ok: boolean; detail: string }> {
  const shim =
    ctx.harness === 'kilocode'
      ? join(ctx.profile, '.config', 'kilo', 'plugin', 'jevris.js')
      : join(ctx.profile, '.config', 'opencode', 'plugins', 'jevris.js');
  const marker = join(ctx.profile, 'jevris-shim-marker');
  let original: string;
  try {
    original = await readFile(shim, 'utf8');
  } catch {
    return { ok: false, detail: 'the installed shim is missing' };
  }
  const opener = 'const server = async (input) => {';
  if (!original.includes(opener)) return { ok: false, detail: 'the installed shim has an unexpected shape' };
  const mark = (text: string): string => `__jevrisMark(${JSON.stringify(marker)}, ${JSON.stringify(`${text}\n`)});`;
  await writeFile(shim, `import { appendFileSync as __jevrisMark } from 'node:fs';\n${mark('loaded')}\n${original.replace(opener, `${opener} ${mark('called')}`)}`);
  await appendFile(marker, '');
  const port = 40000 + Math.floor(Math.random() * 9000);
  const base = `http://127.0.0.1:${port}`; // path-hygiene: allow loopback URL, not a file path
  const server = launchTree(LAUNCHER[ctx.harness], ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { env: ctx.env, cwd: ctx.profile });
  try {
    if (server.pid === undefined) return { ok: false, detail: 'serve was not started' };
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try {
        up = (await fetch(`${base}/config`)).ok; // path-hygiene: allow loopback URL, not a file path
      } catch {
        await sleep(500);
      }
    }
    if (!up) return { ok: false, detail: 'serve did not start' };
    const session = await fetch(`${base}/session?directory=${encodeURIComponent(ctx.profile)}`, { // path-hygiene: allow loopback URL, not a file path
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!session.ok) return { ok: false, detail: `session create failed (${session.status})` };
    await sleep(1500);
    const seen = await readFile(marker, 'utf8');
    const ok = seen.includes('loaded') && seen.includes('called');
    return { ok, detail: ok ? 'plugin loaded and called' : 'plugin not loaded' };
  } finally {
    server.kill();
    await server.done;
    await writeFile(shim, original);
  }
}

function smokeOk(install: OperationReport, check: 'mcp' | 'hook'): boolean {
  return install.ok && install.smoke.some((result) => result.check === check) && install.smoke.filter((result) => result.check === check).every((result) => result.ok);
}

/** The live, per-harness feature checks. Exported for tests with a stub HarnessCli. */
export async function liveFeatureChecks(ctx: LiveContext): Promise<FeatureCheck[]> {
  const mcpSmoke = smokeOk(ctx.install, 'mcp');
  const hookSmoke = smokeOk(ctx.install, 'hook');
  const hooks = feature('hooks.observe', hookSmoke, 'HOOK_SMOKE_FAILED', hookSmoke ? 'installed launcher answered the fixture in observe form' : 'hook smoke failed');
  const jevris = /jevris/i;
  switch (ctx.harness) {
    case 'claude': {
      // SKL-03: the local marketplace under ~/.claude/plugins, installed and enabled.
      const market = join(ctx.profile, CLAUDE_MARKETPLACE_REL);
      const valid = await sees(ctx, ['plugin', 'validate', market], /./);
      const listed = await sees(ctx, ['plugin', 'list', '--json'], /"jevris@jevris-local"/);
      const details = await claudeSkillsListed(ctx);
      const installed = valid.ok && listed.ok;
      return [
        feature('plugin.install', installed, valid.ok ? 'PLUGIN_NOT_LISTED' : 'PLUGIN_NOT_VALID', valid.ok ? listed.detail : valid.detail),
        feature('mcp.tools', mcpSmoke, 'MCP_HANDSHAKE_FAILED', 'installed MCP command answered tools/list'),
        feature('skills.discovery', installed && details.ok, 'SKILLS_NOT_DISCOVERED', details.detail),
        feature('hooks.observe', hookSmoke && installed, 'HOOK_SMOKE_FAILED', installed ? hooks.detail : 'the plugin is not installed in Claude Code'),
      ];
    }
    case 'kilocode':
    case 'opencode': {
      const mcp = await sees(ctx, ['mcp', 'list'], /jevris\b[^\n]*connected/);
      const info = ctx.harness === 'kilocode' ? await sees(ctx, ['debug', 'info'], /plugin[\\/]jevris\.js/) : { ok: true, detail: '' };
      const skills = await skillsDiscovered(ctx);
      const loaded = await pluginLoads(ctx);
      const installed = loaded.ok && info.ok;
      return [
        feature('plugin.install', installed, 'PLUGIN_NOT_LOADED', loaded.ok ? info.detail || loaded.detail : loaded.detail),
        feature('mcp.tools', mcp.ok && mcpSmoke, 'MCP_NOT_CONNECTED', mcp.ok ? 'mcp list: jevris connected' : mcp.detail),
        feature('skills.discovery', skills.ok, 'SKILLS_NOT_DISCOVERED', skills.detail),
        feature('hooks.observe', hookSmoke && loaded.ok, 'HOOK_NOT_LOADED', loaded.ok ? hooks.detail : loaded.detail),
      ];
    }
    case 'codex': {
      const plugins = await sees(ctx, ['plugin', 'list'], jevris);
      const mcp = await sees(ctx, ['mcp', 'list'], jevris);
      return [
        feature('plugin.install', plugins.ok, 'PLUGIN_NOT_LISTED', plugins.detail),
        feature('mcp.tools', mcp.ok && mcpSmoke, 'MCP_NOT_REGISTERED', mcp.detail),
        feature('skills.discovery', plugins.ok, 'PLUGIN_NOT_LISTED', 'skills ship inside the listed plugin'),
        feature('hooks.observe', hookSmoke && plugins.ok, 'HOOK_SMOKE_FAILED', 'plugin hooks still need /hooks trust review in Codex'),
      ];
    }
    case 'antigravity': {
      const plugins = await sees(ctx, ['plugin', 'list'], jevris);
      return [
        feature('plugin.install', plugins.ok, 'PLUGIN_NOT_LISTED', plugins.detail),
        feature('mcp.tools', plugins.ok && mcpSmoke, 'MCP_NOT_REGISTERED', 'MCP ships in the plugin mcp_config.json'),
        feature('skills.discovery', plugins.ok, 'PLUGIN_NOT_LISTED', 'skills ship inside the listed plugin'),
        hooks,
      ];
    }
  }
}

/**
 * The stub case a harness's hooks.route also needs. The hook smoke alone never certifies it: a
 * missing or failed case leaves hooks.route failed, so the sidecar only advises.
 * - Codex (OD-6): the allow plus updatedInput is certified only when `codex.subagent-route` (K2)
 *   passed on this binary, which shows the subagent took the model from the installed adapter's
 *   answer and, under `on-request`, its escalated shell call still asked for approval.
 * - Kilo and OpenCode (R20; B's review, MEDIUM 10): the shim writes the model to the child
 *   session's first message (K3, K4; Kilo's task tool ignores a model argument), and
 *   `<harness>.subagent-route` shows that write runs the subagent on the routed model while the
 *   parent keeps its own.
 * Claude Code's route renders no permission decision, so its record keeps the rendered-protocol proof.
 */
export const ROUTE_STUB_CASES: Readonly<Partial<Record<GlobalHarness, string>>> = {
  codex: 'codex.subagent-route',
  kilocode: 'kilocode.subagent-route',
  opencode: 'opencode.subagent-route',
};
const ROUTE_STUB_REASONS: ReadonlySet<string> = new Set(['ROUTE_CASE_NOT_RUN', 'ROUTE_CASE_FAILED']);

export function routeGatedByStubCase(harness: GlobalHarness, features: readonly FeatureCheck[], stubCases: readonly StubCaseResult[]): FeatureCheck[] {
  const caseId = ROUTE_STUB_CASES[harness];
  if (caseId === undefined) return [...features];
  const found = stubCases.find((item) => item.id === caseId);
  return features.map((item) => {
    if (item.featureId !== 'hooks.route' || !item.passed) return item;
    if (found?.passed === true) return feature('hooks.route', true, 'ROUTE_CASE_FAILED', `${item.detail}; ${caseId} passed`);
    return feature('hooks.route', false, found === undefined ? 'ROUTE_CASE_NOT_RUN' : 'ROUTE_CASE_FAILED', found === undefined ? `the ${caseId} stub case did not run` : `${caseId}: ${found.reasonCode ?? 'FAILED'}`);
  });
}

/**
 * hooks.context and hooks.route: present only when the adapter can deliver them, and
 * certified only when the harness also loaded and ran the installed hooks. Proving that a
 * model reads the injected context would need a model call, which certify never makes; the
 * record's limitations say so.
 */
export function hookFeatureChecks(harness: GlobalHarness, live: readonly FeatureCheck[]): FeatureCheck[] {
  const capable = adapterCapabilities(harness);
  const observed = live.find((item) => item.featureId === 'hooks.observe');
  const loaded = live.find((item) => item.featureId === 'plugin.install');
  const running = observed?.passed === true && loaded?.passed === true;
  const out: FeatureCheck[] = [];
  if (capable.context) out.push(feature('hooks.context', running, 'HOOKS_NOT_RUNNING', running ? 'context outcome renders in the documented shape' : 'the hooks did not run in the harness'));
  if (capable.route) out.push(feature('hooks.route', running, 'HOOKS_NOT_RUNNING', running ? 'a routed subagent input renders; a user pin is never overridden' : 'the hooks did not run in the harness'));
  return out;
}

const SESSION_ROUTE_STUB_REASONS: ReadonlySet<string> = new Set(['SESSION_ROUTE_CASE_NOT_RUN', 'SESSION_ROUTE_CASE_FAILED']);

/** The stub case each harness's session.route needs (OD-8): Kilo and OpenCode only. */
export const SESSION_ROUTE_STUB_CASES: Readonly<Partial<Record<GlobalHarness, string>>> = {
  kilocode: 'kilocode.session-route',
  opencode: 'opencode.session-route',
};

/**
 * session.route (OD-8): a top-level turn's model, switched by the shim from an actuating
 * route.turn answer. Present only when the adapter's shim writes one, and certified only when the
 * installed hooks run and `<harness>.session-route` passed on this binary: a probe plugin's
 * output.message.model ran that turn on the routed model and the next, unrouted turn on the
 * session's own. With neither, D's gate keeps the main session advice only.
 */
export function sessionRouteChecks(harness: GlobalHarness, live: readonly FeatureCheck[], stubCases: readonly StubCaseResult[]): FeatureCheck[] {
  const caseId = SESSION_ROUTE_STUB_CASES[harness];
  if (caseId === undefined || !adapterCapabilities(harness).session) return [];
  const observed = live.find((item) => item.featureId === 'hooks.observe');
  const loaded = live.find((item) => item.featureId === 'plugin.install');
  if (observed?.passed !== true || loaded?.passed !== true) return [feature('session.route', false, 'HOOKS_NOT_RUNNING', 'the hooks did not run in the harness')];
  const found = stubCases.find((item) => item.id === caseId);
  if (found?.passed === true) return [feature('session.route', true, 'SESSION_ROUTE_CASE_FAILED', `the shim writes an actuating route.turn answer; ${caseId} passed`)];
  return [feature('session.route', false, found === undefined ? 'SESSION_ROUTE_CASE_NOT_RUN' : 'SESSION_ROUTE_CASE_FAILED', found === undefined ? `the ${caseId} stub case did not run` : `${caseId}: ${found.reasonCode ?? 'FAILED'}`)];
}

const WORKER_ACTUAL_MODEL_REASONS: ReadonlySet<string> = new Set(['WORKER_ACTUAL_MODEL_CASE_NOT_RUN', 'WORKER_ACTUAL_MODEL_CASE_FAILED']);

/** The K8 stub case each harness's worker.actual-model needs: Codex, Kilo and OpenCode. */
export const WORKER_ACTUAL_MODEL_STUB_CASES: Readonly<Partial<Record<GlobalHarness, string>>> = {
  codex: 'codex.worker-actual-model',
  kilocode: 'kilocode.worker-actual-model',
  opencode: 'opencode.worker-actual-model',
};

/**
 * worker.actual-model (K8; the Linux RC6 run found no record carried it): an owned run's own hooks
 * report the model its request carried. Certified only when the installed hooks run and
 * `<harness>.worker-actual-model` passed on this binary; a case that did not run is never a pass.
 * It does not fail the harness: without it an owned run's reported model stays unconfirmed.
 */
export function workerActualModelChecks(harness: GlobalHarness, live: readonly FeatureCheck[], stubCases: readonly StubCaseResult[]): FeatureCheck[] {
  const caseId = WORKER_ACTUAL_MODEL_STUB_CASES[harness];
  if (caseId === undefined) return [];
  const observed = live.find((item) => item.featureId === 'hooks.observe');
  const loaded = live.find((item) => item.featureId === 'plugin.install');
  if (observed?.passed !== true || loaded?.passed !== true) return [feature('worker.actual-model', false, 'HOOKS_NOT_RUNNING', 'the hooks did not run in the harness')];
  const found = stubCases.find((item) => item.id === caseId);
  if (found?.passed === true) return [feature('worker.actual-model', true, 'WORKER_ACTUAL_MODEL_CASE_FAILED', `an owned run's hooks report the model its request carried; ${caseId} passed`)];
  return [feature('worker.actual-model', false, found === undefined ? 'WORKER_ACTUAL_MODEL_CASE_NOT_RUN' : 'WORKER_ACTUAL_MODEL_CASE_FAILED', found === undefined ? `the ${caseId} stub case did not run` : `${caseId}: ${found.reasonCode ?? 'FAILED'}`)];
}

const HOST_STUB_REASONS: ReadonlySet<string> = new Set(['MODELS_LIST_HOSTS_NOT_RUN', 'MODELS_LIST_HOSTS_FAILED', 'ROUTE_HOST_NEEDS_SESSION_ROUTE', 'ROUTE_HOST_CASE_NOT_RUN', 'ROUTE_HOST_CASE_FAILED']);

/** The serving-host stub cases (R57): K13 (listing), K14 (a route within a host) and K15 (T-R6). Kilo and OpenCode only. */
export const HOST_STUB_CASES: Readonly<Partial<Record<GlobalHarness, { readonly listing: string; readonly route: string; readonly redefined: string }>>> = {
  kilocode: { listing: 'kilocode.models-list-hosts', route: 'kilocode.session-route-host', redefined: 'kilocode.session-route-host-redefined' },
  opencode: { listing: 'opencode.models-list-hosts', route: 'opencode.session-route-host', redefined: 'opencode.session-route-host-redefined' },
};

/**
 * models.list-hosts and route.host (serving hosts R57). models.list-hosts is certified only when
 * `<harness>.models-list-hosts` passed; a case that did not run is never a pass. route.host is
 * certified only when session.route is certified in the same run and both
 * `<harness>.session-route-host` and `<harness>.session-route-host-redefined` passed. Neither
 * fails the harness: without them host routes stay advice only.
 */
export function hostChecks(harness: GlobalHarness, features: readonly FeatureCheck[], stubCases: readonly StubCaseResult[]): FeatureCheck[] {
  const ids = HOST_STUB_CASES[harness];
  if (ids === undefined || !adapterCapabilities(harness).session) return [];
  const byId = (id: string): StubCaseResult | undefined => stubCases.find((item) => item.id === id);
  const listed = byId(ids.listing);
  const listing = listed?.passed === true
    ? feature('models.list-hosts', true, 'MODELS_LIST_HOSTS_FAILED', `the listing keeps each pinned host's spellings; ${ids.listing} passed`)
    : feature('models.list-hosts', false, listed === undefined ? 'MODELS_LIST_HOSTS_NOT_RUN' : 'MODELS_LIST_HOSTS_FAILED', listed === undefined ? `the ${ids.listing} stub case did not run` : `${ids.listing}: ${listed.reasonCode ?? 'FAILED'}`);
  const session = features.find((item) => item.featureId === 'session.route');
  if (session?.passed !== true) return [listing, feature('route.host', false, 'ROUTE_HOST_NEEDS_SESSION_ROUTE', 'session.route is not certified in this run')];
  const cases = [ids.route, ids.redefined].map((id) => ({ id, found: byId(id) }));
  const missing = cases.find((item) => item.found === undefined);
  const failed = cases.find((item) => item.found !== undefined && item.found.passed !== true);
  const route = missing === undefined && failed === undefined
    ? feature('route.host', true, 'ROUTE_HOST_CASE_FAILED', `a route through a host reaches that host, and a project config that redefines it refuses the route; ${ids.route} and ${ids.redefined} passed`)
    : failed !== undefined
      ? feature('route.host', false, 'ROUTE_HOST_CASE_FAILED', `${failed.id}: ${failed.found?.reasonCode ?? 'FAILED'}`)
      : feature('route.host', false, 'ROUTE_HOST_CASE_NOT_RUN', `the ${missing?.id ?? ids.route} stub case did not run`);
  return [listing, route];
}

const ACCESS_STUB_REASONS: ReadonlySet<string> = new Set(['ACCESS_DETECT_CASE_NOT_RUN', 'ACCESS_DETECT_CASE_FAILED', 'ACCESS_SESSION_NEEDS_HOOKS', 'ACCESS_SESSION_EVENT_ABSENT', 'ACCESS_SESSION_CASE_NOT_RUN', 'ACCESS_SESSION_CASE_FAILED', ACCESS_USAGE_ISOLATION_UNAVAILABLE, 'ACCESS_USAGE_CASE_NOT_RUN', 'ACCESS_USAGE_CASE_FAILED']);
const ACCESS_DETECT_HARNESSES: ReadonlySet<GlobalHarness> = new Set(['claude', 'codex', 'kilocode', 'opencode']);

/**
 * access.usage-read (K21, OP-6; coordinator decision DOMAINS 3298853d): certified only when the
 * isolated case passed. Where no OS network isolation could be set up it is unsupported with
 * ACCESS_USAGE_ISOLATION_UNAVAILABLE; a violated isolation or any other failure is
 * ACCESS_USAGE_CASE_FAILED. None of these fails the harness: an uncertified reading only sets a
 * timed usage window.
 */
export function usageReadCheck(found: StubCaseResult | undefined): FeatureCheck {
  if (found === undefined) return feature('access.usage-read', false, 'ACCESS_USAGE_CASE_NOT_RUN', `the ${USAGE_READ_CASE_ID} stub case did not run`);
  if (found.passed) return feature('access.usage-read', true, 'ACCESS_USAGE_CASE_FAILED', `${USAGE_READ_CASE_ID} passed: ${found.detail}`);
  if (found.reasonCode === ACCESS_USAGE_ISOLATION_UNAVAILABLE) return feature('access.usage-read', false, ACCESS_USAGE_ISOLATION_UNAVAILABLE, found.detail);
  return feature('access.usage-read', false, 'ACCESS_USAGE_CASE_FAILED', `${USAGE_READ_CASE_ID}: ${found.reasonCode ?? 'FAILED'}`);
}

/**
 * access.detect and access.session (access limits R69). access.detect is certified only when all
 * three of the harness's K16-K18 cases passed; a case that did not run is never a pass.
 * access.session needs hooks.observe and the plugin loaded in this run, then its K19 or K20 case:
 * a binary that never sent the event is ACCESS_SESSION_EVENT_ABSENT (a documented unsupported
 * feature), any other failure ACCESS_SESSION_CASE_FAILED. Neither fails the harness.
 */
export function accessChecks(harness: GlobalHarness, live: readonly FeatureCheck[], stubCases: readonly StubCaseResult[]): FeatureCheck[] {
  const out: FeatureCheck[] = [];
  const byId = (id: string): StubCaseResult | undefined => stubCases.find((item) => item.id === id);
  if (ACCESS_DETECT_HARNESSES.has(harness)) {
    const cases = accessDetectCaseIds(harness as AccessCaseHarness).map((id) => ({ id, found: byId(id) }));
    const failed = cases.find((item) => item.found !== undefined && item.found.passed !== true);
    const missing = cases.find((item) => item.found === undefined);
    out.push(
      failed !== undefined
        ? feature('access.detect', false, 'ACCESS_DETECT_CASE_FAILED', `${failed.id}: ${failed.found?.reasonCode ?? 'FAILED'}`)
        : missing !== undefined
          ? feature('access.detect', false, 'ACCESS_DETECT_CASE_NOT_RUN', `the ${missing.id} stub case did not run`)
          : feature('access.detect', true, 'ACCESS_DETECT_CASE_FAILED', `the port reads a rate limit, a credit error and a sign-in error; ${cases.map((item) => item.id).join(', ')} passed`),
    );
  }
  if (harness === 'codex') out.push(usageReadCheck(byId(USAGE_READ_CASE_ID)));
  const sessionCase = ACCESS_SESSION_CASES[harness];
  if (sessionCase === undefined) return out;
  const observed = live.find((item) => item.featureId === 'hooks.observe');
  const loaded = live.find((item) => item.featureId === 'plugin.install');
  if (observed?.passed !== true || loaded?.passed !== true) return [...out, feature('access.session', false, 'ACCESS_SESSION_NEEDS_HOOKS', 'the hooks did not run in the harness')];
  const found = byId(sessionCase);
  if (found === undefined) return [...out, feature('access.session', false, 'ACCESS_SESSION_CASE_NOT_RUN', `the ${sessionCase} stub case did not run`)];
  if (found.passed) return [...out, feature('access.session', true, 'ACCESS_SESSION_CASE_FAILED', `a failed turn reaches the hooks with a structured error; ${sessionCase} passed`)];
  return [...out, feature('access.session', false, found.reasonCode === 'EVENT_ABSENT' ? 'ACCESS_SESSION_EVENT_ABSENT' : 'ACCESS_SESSION_CASE_FAILED', `${sessionCase}: ${found.reasonCode ?? 'FAILED'}`)];
}

/**
 * HCF-02: managed policy that stops hooks is system-wide, so it applies to the real binary
 * even in the temporary profile. Every hook feature then fails with the policy as its reason;
 * certify never works around it.
 */
export function applyManagedPolicy(features: readonly FeatureCheck[], policies: readonly ManagedHookPolicy[]): FeatureCheck[] {
  const [first] = policies;
  if (first === undefined) return [...features];
  return features.map((item) => (item.featureId.startsWith('hooks.') ? feature(item.featureId, false, 'MANAGED_POLICY_BLOCKS_HOOKS', managedPolicyLine(first)) : item));
}

export interface CertifyOptions {
  readonly home: string;
  readonly harness: GlobalHarness;
  /** Managed hook policy in force; default read from the OS for Claude Code. */
  readonly policies?: readonly ManagedHookPolicy[];
  readonly json: boolean;
  readonly root: string;
  /**
   * Directory for the two release-evidence files. Default `<data>/evidence`. A directory the user
   * names is confined (GOV-11): inside the working directory, the home or the temp directory,
   * never a Jevris private directory, `.git`, `.ssh` or `.gnupg`, and reached through no link.
   */
  readonly evidence?: string;
  /** The working directory `--evidence` is resolved against. Default process.cwd(). */
  readonly cwd?: string;
  /** PKCS#8 PEM file of a release `certification` key; default the local key. */
  readonly signingKey?: string;
  readonly keyId?: string;
  readonly cli?: HarnessCli;
  readonly nowMs?: number;
  /**
   * The background re-check's marker (reverify.ts): certify writes its result there when it
   * ends. Only a marker inside this home's reverify folder is accepted.
   */
  readonly reverify?: string;
  /** Tests: the models.list listing runner (default runModelListing, the real binary in the profile). */
  readonly listModels?: (input: RawListingInput) => Promise<RawListing>;
  /**
   * The no-cost stub cases (R33; stub-cases.ts): one real turn against the loopback stub
   * provider. `false` skips them; tests may pass their own runner. They report and gate nothing yet.
   */
  readonly stubCases?: false | ((ctx: StubCaseContext) => Promise<readonly StubCaseResult[]>);
}

export interface CertifyResult {
  readonly ok: boolean;
  readonly harness: GlobalHarness;
  readonly harnessVersion: string | null;
  readonly features: readonly FeatureCheck[];
  readonly cases: readonly ConformanceCase[];
  /** worker.route: the worker port's nine §15.4 cases against a stand-in (no model call). */
  readonly workerCases?: readonly ConformanceCase[];
  /** The stub cases' results (R33): reported, not yet a gate. */
  readonly stubCases?: readonly StubCaseResult[];
  readonly record: string | null;
  readonly evidence: readonly string[];
  readonly error: string | null;
  /** Set when the `--evidence` path was refused (GOV-11); nothing was run or written. */
  readonly outputRefused?: OutputPathRefusal;
  /**
   * The found-gone signal rows for this harness (C's table) at this version: whether each one
   * counts, and what the separate `--model-signals` capture would launch. Certify never runs it.
   */
  readonly modelSignals?: readonly string[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function signingKey(options: CertifyOptions): Promise<{ keyId: string; privateKeyPem: string }> {
  if (options.signingKey !== undefined) {
    if (options.keyId === undefined) throw new Error('--signing-key needs --key-id');
    return { keyId: options.keyId, privateKeyPem: await readFile(options.signingKey, 'utf8') };
  }
  return localSigningKey(options.home);
}

function osId(): 'darwin' | 'linux' | 'win32' | null {
  return process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32' ? process.platform : null;
}

/**
 * The harness CLI certify uses, or null when certify may not start a harness here: in a test
 * run (JEVRIS_TEST, JEVRIS_NO_LIVE_HARNESS or a node test run) the default CLI starts nothing
 * unless JEVRIS_LIVE_HARNESS=1 asks for a live smoke (a real binary, or pack smoke's
 * certifiable stand-ins first on PATH). An injected CLI (tests) is used as it is.
 */
function certifyCli(cli: HarnessCli): HarnessCli | null {
  return cli === defaultHarnessCli && !liveHarnessAllowed() ? null : cli;
}

/** The harness's compatibility rule from plugins/<harness>/harness.json; same-minor when absent. */
export async function compatibilityRule(root: string, harness: GlobalHarness): Promise<CompatibilityRule> {
  try {
    const manifest = parseHarnessManifest(await readFile(join(root, 'plugins', harness, 'harness.json'), 'utf8'), harness).manifest;
    return manifest?.compatibility?.rule ?? 'same-minor';
  } catch {
    return 'same-minor';
  }
}

/**
 * The feature list a certify run records: the live checks, the hook features they allow, any
 * other checks of the run (worker.route, models.list), session.route, models.list-hosts and
 * route.host (R57), and the access features, gated by the stub cases and the managed policy.
 * certifyHarness and the route.host record test use this one composition.
 */
export function recordFeatures(input: { readonly harness: GlobalHarness; readonly live: readonly FeatureCheck[]; readonly extra: readonly FeatureCheck[]; readonly stubCases: readonly StubCaseResult[]; readonly policies: readonly ManagedHookPolicy[] }): FeatureCheck[] {
  const sessionRoute = sessionRouteChecks(input.harness, input.live, input.stubCases);
  return applyManagedPolicy(
    routeGatedByStubCase(
      input.harness,
      [...input.live, ...hookFeatureChecks(input.harness, input.live), ...input.extra, ...sessionRoute, ...hostChecks(input.harness, sessionRoute, input.stubCases), ...workerActualModelChecks(input.harness, input.live, input.stubCases), ...accessChecks(input.harness, input.live, input.stubCases)],
      input.stubCases,
    ),
    input.policies,
  );
}

export interface CertificationRecordInput {
  readonly harness: GlobalHarness;
  readonly os: 'darwin' | 'linux' | 'win32';
  readonly harnessVersion: string;
  readonly nowMs: number;
  /** Package root holding plugins/<harness>/harness.json (the compatibility rule). */
  readonly root: string;
  readonly features: readonly FeatureCheck[];
  /** Every conformance case passed; a record with a failed case certifies no feature. */
  readonly conformant: boolean;
  readonly suiteHash: string;
  readonly key: { readonly keyId: string; readonly privateKeyPem: string };
}

/** The signed record a certify run writes: the version range, the limitations and each feature's status. */
export async function signedCertificationRecord(input: CertificationRecordInput): Promise<CertificationRecord> {
  const unsigned = {
    id: `cert-${input.harness}-${input.os}-${input.harnessVersion}-${input.nowMs}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128),
    schemaVersion: '1.0' as const,
    harness: input.harness,
    actuatorId: `${input.harness}.observe`,
    harnessVersionRange: { minimum: input.harnessVersion.replace(/-.*$/, ''), maximumExclusive: versionBound(input.harnessVersion, await compatibilityRule(input.root, input.harness)) },
    operatingSystems: [input.os],
    models: [],
    tools: [],
    limitations: [
      'Jevris never blocks, denies or asks on a harness action.',
      'hooks.context and hooks.route are proven on the rendered protocol and a running hook, not on a model call.',
      ...(input.harness === 'antigravity' ? ['PreToolUse is never registered: its allow would auto-approve the tool call and override native permissions.'] : []),
      ...(input.harness === 'codex'
        ? [
            'Plugin hooks need a one-time /hooks trust review in Codex.',
            "A certified route answers spawn_agent with allow plus updatedInput, which in Codex only carries the rewrite. It reads spawn_agent under its plain name and under Codex's default MultiAgentV2 namespace name, collaborationspawn_agent; a call in a namespace you set is never routed. codex.subagent-route proves Codex's handling of the adapter's exact rendered bytes; the path from launcher to sidecar to adapter is proven by the conformance and launcher cases, not live.",
          ]
        : []),
      ...(input.harness === 'kilocode' || input.harness === 'opencode'
        ? [
            `A certified route writes only a model: a subagent's first message (hooks.route) or a top-level turn's message (session.route), never to a provider the project's own config redefines. The ${input.harness}.subagent-route and ${input.harness}.session-route cases prove the harness honours those writes, made by a probe plugin; the shim's own path is proven by the adapter tests and conformance cases, not live.`,
          ]
        : []),
      ...workerLimitations(input.harness),
    ],
    fixtureSuiteHash: input.suiteHash,
    features: CERTIFICATION_FEATURES.filter((featureId) => input.features.some((item) => item.featureId === featureId)).map((featureId) => {
      const check = input.features.find((item) => item.featureId === featureId);
      const passed = check?.passed === true && input.conformant;
      return { featureId, status: passed ? ('certified' as const) : ('unsupported' as const), reasonCode: passed ? null : (check?.reasonCode ?? 'CONFORMANCE_FAILED') };
    }),
    certifiedAt: iso(input.nowMs),
    expiresAt: iso(input.nowMs + VALIDITY_DAYS * DAY_MS),
  };
  return signRecord(unsigned, input.key.privateKeyPem, input.key.keyId) as unknown as CertificationRecord;
}

/** Runs the certification. Never throws; `error` says what stopped it. */
export async function certifyHarness(options: CertifyOptions): Promise<CertifyResult> {
  const base = { ok: false, harness: options.harness, harnessVersion: null, features: [], cases: [], record: null, evidence: [] };
  const cli = certifyCli(options.cli ?? defaultHarnessCli);
  if (cli === null) {
    return { ...base, error: 'certify starts the real harness binary, which is disabled in a test run (JEVRIS_NO_LIVE_HARNESS, JEVRIS_TEST or a test runner) unless JEVRIS_LIVE_HARNESS=1 is set' };
  }
  const os = osId();
  if (os === null) return { ...base, error: `certification covers darwin, linux and win32, not ${process.platform}` };
  const evidenceNames = [`harness-conformance-${options.harness}-${os}.json`, `certification-record-${options.harness}-${os}.json`] as const;
  const confine = { jevrisHome: options.home, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) };
  if (options.evidence !== undefined) {
    // GOV-11: a user-named evidence directory is checked before the harness runs.
    for (const name of evidenceNames) {
      const checked = await confineOutputPath(join(options.evidence, name), confine);
      if (!checked.ok) return { ...base, error: `--evidence refused (${checked.reasonCode}): ${join(options.evidence, name)}`, outputRefused: checked.reasonCode };
    }
  }
  const bin = LAUNCHER[options.harness];
  if (!cli.available(bin)) {
    // Antigravity: only its CLI is headless; the app and IDE load plugins only in their GUI.
    const hint = options.harness === 'antigravity' ? antigravityCertifyHint(antigravityProducts({ home: options.home })) : `${bin} is not on PATH; install ${options.harness} first`;
    return { ...base, error: hint };
  }
  const manifest: RuntimeManifest | null = await readRuntimeManifest(options.root);
  if (manifest === null) return { ...base, error: `no runtime manifest in ${options.root}; run npm run build or reinstall` };
  const profile = await mkdtemp(join(tmpdir(), `jevris-certify-${options.harness}-`));
  const { env, harnessHome } = certifyEnv(options.harness, profile);
  try {
    const harnessVersion = await probeHarnessVersion(options.harness, cli, env);
    if (harnessVersion === null) return { ...base, error: `${bin} --version did not print a version` };
    await recordVersion(options.home, options.harness, harnessVersion);
    // G17: Antigravity's hook group is written disabled until a record covers the version, so
    // the throwaway profile gets it enabled: certify then loads the hooks it certifies, not an
    // inert group. The profile is removed afterwards; the home is never written this way.
    const profileHooks = options.harness === 'antigravity' ? async (): Promise<boolean> => true : undefined;
    const install = await installGlobal({ home: profile, root: options.root, harness: options.harness, cli, env, ...(harnessHome === null ? {} : { harnessHome }) }, profileHooks);
    if (!install.ok) return { ...base, harnessVersion, error: `install into the temp profile failed: ${install.error ?? install.status}` };
    const live = await liveFeatureChecks({ harness: options.harness, cli, env, profile, install });
    const policies = options.policies ?? (options.harness === 'claude' ? await managedHookPolicies() : []);
    // worker.route: the help lists every flag the worker passes, and the port passes its nine
    // cases against a stand-in in the temp profile. No model call; pending first use.
    const worker = await workerRouteCheck(options.harness, cli, env, profile);
    const workerFeature = feature('worker.route', worker.passed, worker.reasonCode, worker.detail);
    // models.list (DOMAINS 3f090fa): the harness's own listing in the temp profile, with the
    // profile snapshotted around it; a session, history or config write, or a self-update, fails it.
    const listing = await modelListCheck({ harness: options.harness, env, profile, ...(options.listModels === undefined ? {} : { run: options.listModels }) });
    const listingFeature = listing === null ? [] : [feature('models.list', listing.passed, listing.reasonCode ?? 'LISTING_FAILED', listing.detail)];
    const runtime = install.runtime?.dir ?? null;
    const hook = runtime === null ? null : runtimeEntry(runtime, manifest, 'hook');
    // R33: real turns against the loopback stub, after every other check so they see the
    // profile as install left it. Reported in certify's output and JSON, and each case's reason
    // code goes to the conformance evidence (stubCaseEvidence). Several gate features: Codex's
    // hooks.route needs its K2 case, for example.
    const stubCases = options.stubCases === false ? [] : await (options.stubCases ?? runStubCases)({ harness: options.harness, cli, env, profile, hookEntry: hook });
    const features = recordFeatures({ harness: options.harness, live, extra: [workerFeature, ...listingFeature], stubCases, policies });
    const launched = hook === null ? new Map() : await launcherCases({ harness: options.harness, node: process.execPath, hook, home: profile });
    const cases = mergeCases(adapterCases(options.harness), launched);
    const nowMs = options.nowMs ?? Date.now();
    const conformant = cases.every((item) => item.passed);
    const suiteHash = fixtureSuiteHash(options.harness);
    const record = await signedCertificationRecord({ harness: options.harness, os, harnessVersion, nowMs, root: options.root, features, conformant, suiteHash, key: await signingKey(options) });
    const checked = CertificationRecordContract.validate(record);
    if (!checked.ok) return { ...base, harnessVersion, features, cases, error: `the record did not pass its contract (${checked.issues[0]?.path ?? ''})` };
    const recordPath = join(certificationsDir(options.home), `${options.harness}-${os}.json`);
    const common = {
      producedAt: iso(nowMs),
      version: manifest.version,
      commit: evidenceCommit(manifest),
      // producer.tool is an Id: no spaces.
      tool: 'jevris-certify',
      os,
      arch: String(Reflect.get(process, 'arch') ?? ''),
      node: process.version,
    };
    const conformance = releaseEvidence({
      ...common,
      kind: 'harness-conformance',
      id: `harness-conformance-${options.harness}-${os}-${nowMs}`,
      // The worker port's nine cases (the `<harness>.worker` actuator, A's harness gate). A failed
      // case's own reason is free text, so the evidence carries its reason code instead.
      payload: {
        harness: options.harness,
        os,
        harnessVersion,
        realBinary: true,
        fixtureSuiteHash: suiteHash,
        cases,
        workerCases: worker.cases.map((item) => ({ id: item.id, passed: item.passed, reasonCode: item.passed ? null : 'WORKER_CONFORMANCE_FAILED' })),
        ...(listing === null ? {} : { listing: listingEvidence(listing) }),
        ...(stubCases.length === 0 ? {} : { stubCases: stubCaseEvidence(options.harness, stubCases) }),
      },
    });
    const certification = releaseEvidence({ ...common, kind: 'certification-record', id: `certification-record-${options.harness}-${os}-${nowMs}`, payload: record });
    const bodies = [`${JSON.stringify(conformance, null, 2)}\n`, `${JSON.stringify(certification, null, 2)}\n`] as const;
    // Every envelope must pass the contract `jevris gates` reads it with, checked on the exact
    // bytes written, before anything is written; a certify run never leaves evidence gates reject.
    for (const body of bodies) {
      const envelope = ReleaseEvidenceContract.validate(JSON.parse(body));
      if (!envelope.ok) {
        const issue = envelope.issues[0];
        return { ...base, harnessVersion, features, cases, error: `the release evidence did not pass its contract (${issue?.code ?? 'invalid'} at ${issue?.path ?? '/'}); nothing was written` };
      }
    }
    await writePrivateFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    const files: string[] = [];
    if (options.evidence === undefined) {
      const evidenceDir = join(jevrisPaths({ home: options.home }).data, 'evidence');
      for (const [index, name] of evidenceNames.entries()) {
        const file = join(evidenceDir, name);
        await writePrivateFile(file, bodies[index] as string);
        files.push(file);
      }
    } else {
      for (const [index, name] of evidenceNames.entries()) {
        const written = await writeConfinedOutput(join(options.evidence, name), bodies[index] as string, confine);
        if (!written.ok) {
          return { ...base, harnessVersion, features, cases, record: recordPath, evidence: files, error: `--evidence refused (${written.reasonCode}): ${join(options.evidence, name)}`, outputRefused: written.reasonCode };
        }
        files.push(written.path);
      }
    }
    // models.list is optional: a failed listing leaves only the listing off (a model becomes
    // eligible after it has run once), so it never fails the harness's certification. A route
    // held back by its stub case is optional too: routing then only advises (OD-6), and so is a
    // session route held back by its case (OD-8), the serving-host features (R57) and the
    // access-limit features (R69): what is read without them differs by harness (doctor-cli.ts,
    // OPTIONAL_FEATURES); on Claude Code a session limit is not read until access.session is.
    const ok = conformant && features.every((item) => item.passed || item.featureId === 'models.list' || (item.featureId === 'hooks.route' && ROUTE_STUB_REASONS.has(item.reasonCode ?? '')) || (item.featureId === 'session.route' && SESSION_ROUTE_STUB_REASONS.has(item.reasonCode ?? '')) || (item.featureId === 'worker.actual-model' && WORKER_ACTUAL_MODEL_REASONS.has(item.reasonCode ?? '')) || ((item.featureId === 'models.list-hosts' || item.featureId === 'route.host') && HOST_STUB_REASONS.has(item.reasonCode ?? '')) || ((item.featureId === 'access.detect' || item.featureId === 'access.session' || item.featureId === 'access.usage-read') && ACCESS_STUB_REASONS.has(item.reasonCode ?? '')));
    const modelSignals = [...modelSignalRows(options.harness, await loadModelSignalCapture(options.home, options.harness), harnessVersion), `model-signal capture: not run by certify; jevris certify --harness ${options.harness} --model-signals launches: ${MODEL_SIGNAL_CASES[options.harness].launches}`];
    return { ok, harness: options.harness, harnessVersion, features, cases, workerCases: worker.cases, stubCases, record: recordPath, evidence: files, error: ok ? null : 'some checks failed; the record lists those features as unsupported', modelSignals };
  } catch (error) {
    return { ...base, error: `certify failed: ${String((error as { message?: unknown }).message ?? error).slice(0, 200)}` };
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

const UNSAFE_PATH = [...SECRET_PATTERNS, ...URL_PATTERNS, EMAIL_PATTERN].map((pattern) => new RegExp(pattern, 'u'));
const LISTING_REASON = new RegExp(REASON_CODE_PATTERN);
const RELATIVE_PATH = new RegExp(LISTING_EVIDENCE_PATH_PATTERN, 'u');

/**
 * models.list's row in the conformance evidence: its reason code (null when it passed) and the
 * paths its checked run touched, relative to the throwaway profile. At most 64 paths of 200
 * characters, each listed once, never a file's contents. A path that is not plainly relative, or
 * that looks like it holds a secret, a URL or an email address, is recorded once as
 * `[path withheld]`, so the evidence always passes its contract.
 */
export function listingEvidence(check: ModelListCheck): { readonly reasonCode: string | null; readonly touched: readonly string[] } {
  const reasonCode = check.passed ? null : LISTING_REASON.test(check.reasonCode ?? '') ? (check.reasonCode as string) : 'LISTING_FAILED';
  const touched = new Set<string>();
  for (const path of check.touched) {
    if (touched.size >= LISTING_EVIDENCE_PATHS_MAX) break;
    const cut = path.slice(0, LISTING_EVIDENCE_PATH_CHARS);
    touched.add(!RELATIVE_PATH.test(cut) || UNSAFE_PATH.some((pattern) => pattern.test(cut)) ? '[path withheld]' : cut);
  }
  return { reasonCode, touched: [...touched] };
}

const STUB_CASE_ID = new RegExp(ID_PATTERN);
const UNSAFE_ID = SECRET_PATTERNS.map((pattern) => new RegExp(pattern, 'u'));

/**
 * The stub cases' rows in the conformance evidence: each case's id, whether it passed and its
 * reason code (null when it passed), so a failed route or access case can be read without a
 * paste. The detail text is never recorded. At most STUB_CASE_EVIDENCE_MAX rows. An id that is
 * not a plain id is recorded as `<harness>.stub-case-<n>`, and a reason that is not a reason code
 * as STUB_CASE_FAILED, so the evidence always passes its contract.
 */
export function stubCaseEvidence(harness: GlobalHarness, cases: readonly StubCaseResult[]): StubCaseEvidenceRow[] {
  return cases.slice(0, STUB_CASE_EVIDENCE_MAX).map((item, index) => {
    const trace = traceEvidence(item.trace ?? []);
    return {
      id: STUB_CASE_ID.test(item.id) && !UNSAFE_ID.some((pattern) => pattern.test(item.id)) ? item.id : `${harness}.stub-case-${index + 1}`,
      passed: item.passed,
      reasonCode: item.passed ? null : LISTING_REASON.test(item.reasonCode ?? '') ? (item.reasonCode as string) : 'STUB_CASE_FAILED',
      ...(trace.length === 0 ? {} : { trace }),
    };
  });
}

export interface StubCaseEvidenceRow {
  readonly id: string;
  readonly passed: boolean;
  readonly reasonCode: string | null;
  readonly trace?: readonly StubTraceEntry[];
}

const TRACE_FROM = new Set(['server', 'client', 'hook', 'stub']);
const TRACE_NAME = new RegExp(STUB_TRACE_NAME_PATTERN, 'u');
const TRACE_THREAD = /^(?:parent|child-[0-9]{1,2}|none)$/u;

/**
 * A case's trace for the evidence (K2): names and thread roles only, checked again here so the
 * evidence always passes its contract. A name that is not a plain name, or matches a secret, URL
 * or email pattern, becomes `unnamed`; an odd thread role becomes `none`.
 */
function traceEvidence(trace: readonly StubTraceEntry[]): StubTraceEntry[] {
  return trace.slice(0, STUB_TRACE_MAX).flatMap((item) => {
    if (!TRACE_FROM.has(item.from)) return [];
    const name = TRACE_NAME.test(item.name) && !UNSAFE_PATH.some((pattern) => pattern.test(item.name)) ? item.name : 'unnamed';
    const count = Number.isSafeInteger(item.count) ? Math.min(Math.max(item.count, 1), 1_000_000) : 1;
    return [{ from: item.from, name, thread: TRACE_THREAD.test(item.thread) ? item.thread : 'none', count }];
  });
}

/**
 * The commit certify's evidence names: the one the build stamped into its runtime manifest
 * (A's build, d449a54), so a release run with --commit matches the evidence to the certified
 * build. A dirty build, or one with no source, never claims a commit.
 */
export function evidenceCommit(manifest: Pick<RuntimeManifest, 'source'>): string | null {
  return manifest.source === undefined || manifest.source.dirty ? null : manifest.source.commit;
}

export function formatCertify(result: CertifyResult): string {
  const lines = [`jevris certify ${result.harness}: ${result.ok ? 'certified' : 'not certified'}${result.harnessVersion === null ? '' : ` (version ${result.harnessVersion})`}`];
  for (const item of result.features) lines.push(`  feature ${item.featureId}: ${item.passed ? 'pass' : `fail (${item.reasonCode ?? ''})`} - ${item.detail}`);
  for (const item of result.cases) lines.push(`  case ${item.id}: ${item.passed ? 'pass' : `fail (${item.reasonCode ?? ''})`}`);
  for (const item of result.workerCases ?? []) lines.push(`  worker case ${item.id}: ${item.passed ? 'pass' : `fail (${item.reasonCode ?? ''})`}`);
  for (const line of stubCaseLines(result.stubCases ?? [])) lines.push(`  ${line}`);
  for (const line of result.modelSignals ?? []) lines.push(`  ${line}`);
  if (result.record !== null) lines.push(`  record: ${result.record}`);
  for (const file of result.evidence) lines.push(`  evidence: ${file}`);
  if (result.error !== null) lines.push(`  ${result.error}`);
  return `${lines.join('\n')}\n`;
}

export async function runCertifyCommand(options: CertifyOptions, write: (text: string) => void): Promise<number> {
  if (options.reverify !== undefined && !isReverifyMarker(options.home, options.reverify)) {
    write(`jevris certify: --reverify must name a marker in ${reverifyDir(options.home)}\n`);
    return COMMAND_EXIT_CODES.usage;
  }
  const result = await certifyHarness(options);
  if (options.reverify !== undefined) {
    const failed: { featureId: string; reasonCode: string }[] = result.features.filter((item) => !item.passed).map((item) => ({ featureId: item.featureId, reasonCode: item.reasonCode ?? 'FAILED' }));
    if (result.error !== null && failed.length === 0) failed.push({ featureId: 'certify', reasonCode: result.error.slice(0, 120) });
    await finishReverify(options.home, options.reverify, result.ok, failed);
  }
  write(options.json ? `${JSON.stringify(result)}\n` : formatCertify(result));
  if (result.outputRefused !== undefined) return COMMAND_EXIT_CODES.usage;
  return result.ok ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative;
}

/**
 * `jevris certify --harness all`: certifies every harness Jevris is installed in on this home
 * (or, with none installed, every harness whose binary is found), one after another, each in
 * its own throwaway profile. Exit 0 only when every one is certified.
 */
export async function runCertifyAllCommand(options: Omit<CertifyOptions, 'harness'>, write: (text: string) => void): Promise<number> {
  const cli = options.cli ?? defaultHarnessCli;
  const installed = await installedHarnesses(jevrisPaths({ home: options.home }).data);
  const targets = installed.length > 0 ? installed : GLOBAL_HARNESSES.filter((harness) => cli.available(LAUNCHER[harness]));
  if (targets.length === 0) {
    write(options.json ? `${JSON.stringify({ ok: false, results: [], error: 'no harness to certify' })}\n` : 'jevris certify: no harness to certify; run jevris install first\n');
    return COMMAND_EXIT_CODES.negative;
  }
  const results: CertifyResult[] = [];
  for (const harness of targets) {
    const result = await certifyHarness({ ...options, harness });
    results.push(result);
    if (!options.json) write(formatCertify(result));
    if (result.outputRefused !== undefined) break;
  }
  const ok = results.length === targets.length && results.every((result) => result.ok);
  if (options.json) write(`${JSON.stringify({ ok, results })}\n`);
  else write(`jevris certify all: ${results.filter((result) => result.ok).length} of ${targets.length} certified${ok ? '' : `; not certified: ${results.filter((result) => !result.ok).map((result) => result.harness).join(', ')}`}\n`);
  if (results.some((result) => result.outputRefused !== undefined)) return COMMAND_EXIT_CODES.usage;
  return ok ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative;
}
