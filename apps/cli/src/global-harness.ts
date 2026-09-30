import { cp, lstat, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot, jevrisPaths, resolveExecutable, resolveHome, shellQuote } from '@jevris/platform';
import { PUBLIC_COMMAND_NAMES, type CertificationFeature } from '@jevris/contracts';
import { CLAUDE_GATED_EVENTS } from '@jevris/adapter-claude-code';
import { EVENT_TIMEOUTS as CODEX_TIMEOUTS, REGISTERED_EVENTS as CODEX_EVENTS } from '@jevris/adapter-codex';
import { EVENT_TIMEOUTS as AGY_TIMEOUTS, REGISTERED_EVENTS as AGY_EVENTS } from '@jevris/adapter-antigravity';
import { renderShimPlugin } from '@jevris/adapter-kilocode';
import type { InstallResult } from './install.js';
import { findNode, nodeValue, parseJsoncTree } from './jsonc-edit.js';
import { scanHooks } from './hook-scan.js';
import { readSkillSources, renderSkillTree, skillProfile, type SkillEntry } from './skill-render.js';
import { mcpEntry, parseHarnessManifest, type HarnessManifest } from './harness-manifest.js';
import { accountHome, launchTree, liveHarnessAllowed, runBounded } from './live-harness.js';
import {
  applyArrayEntry,
  applyJsonKey,
  applyJsonKeys,
  backupSetName,
  boundedPath,
  casDelete,
  casWrite,
  currentJournal,
  dataRel,
  decodeText,
  homePair,
  insideHome,
  InstallJournal,
  InstallTxn,
  journaledRemove,
  legacyOwnedPaths,
  parseReceipt,
  pruneBackups,
  readBytes,
  receiptExtra,
  setActiveJournal,
  settleLeftoverDirs,
  sha256,
  stripText,
  uninstallV2,
  type EditRecord,
  type HomePair,
  type StripSpec,
  type TxnHooks,
} from './owned-install.js';
import {
  commitRuntime,
  copyRuntime,
  planRuntime,
  pruneRuntimes,
  readRuntimeManifest,
  rollbackRuntime,
  runtimeDir,
  runtimeEntry,
  type RuntimeCopy,
  type RuntimeManifest,
} from './runtime-install.js';
import { appendTomlBlock, hasTomlTable, tomlString } from './toml-edit.js';
import { deleteJevrisData } from './uninstall.js';
import { runInstallSmoke, type SmokeResult } from './install-smoke.js';
import { refreshHarnessVersions } from './harness-versions.js';
import { walkPrivate } from './private-tighten.js';
import { planLauncher, removeCommand, repointLauncher, writeLauncher, type CommandPlace, type RegExec } from './command-launcher.js';

/**
 * Global harness install, upgrade and uninstall (installer v2: ADM-02..06, CLA-01, KIL-01,
 * CDX-01, CDX-02, OPC-01, OPC-02, AGY-01..03).
 *
 * One operation (install, upgrade or uninstall of one or all harnesses):
 * 1. copies the versioned runtime to `<data>/runtime/<version>/` (ADM-03);
 * 2. journals every file it touches, with a backup and a manifest (ADM-04);
 * 3. removes the previous install of each harness by its receipt, and migrates what a
 *    v1.x install left behind (namespaced keys it never listed, Jevris-signature files);
 * 4. writes each harness's plugin, registration and skills, pointing at the runtime;
 * 5. runs a post-install smoke (MCP initialize and tools/list, a hook fixture through the
 *    installed command line);
 * 6. on any failure restores every touched file that still holds what this operation
 *    wrote, and removes the new runtime.
 *
 * Shared config edits go through the JSONC and TOML editors with compare-and-swap and
 * receipt splices, so uninstall restores the user's bytes exactly (phase 25).
 */

export const GLOBAL_HARNESSES = ['claude', 'kilocode', 'codex', 'opencode', 'antigravity'] as const;
export type GlobalHarness = (typeof GLOBAL_HARNESSES)[number];

const ALIASES: Readonly<Record<string, GlobalHarness>> = {
  claude: 'claude',
  'claude-code': 'claude',
  kilo: 'kilocode',
  kilocode: 'kilocode',
  codex: 'codex',
  opencode: 'opencode',
  agy: 'antigravity',
  antigravity: 'antigravity',
};

export function normalizeHarness(value: string): GlobalHarness | null {
  return ALIASES[value.toLowerCase()] ?? null;
}

export function isGlobalHarness(value: string): value is GlobalHarness {
  return (GLOBAL_HARNESSES as readonly string[]).includes(value);
}

/** The launcher name the hook runtime takes for each harness (`--harness <name>`). */
export const LAUNCHER: Readonly<Record<GlobalHarness, string>> = {
  claude: 'claude',
  kilocode: 'kilo',
  codex: 'codex',
  opencode: 'opencode',
  antigravity: 'agy',
};

/** The installed package root: the directory whose package.json names Jevris. */
export function packageRoot(moduleUrl: string): string {
  return findPackageRoot(moduleUrl) ?? fileURLToPath(new URL('../../..', moduleUrl));
}

interface ReceiptSpec {
  readonly name: string;
  readonly pluginId: string;
}

/** The current receipt first, then receipts earlier versions wrote. */
export const RECEIPTS: Readonly<Record<GlobalHarness, readonly ReceiptSpec[]>> = {
  claude: [
    { name: 'claude-install-receipt.json', pluginId: 'jevris@jevris-local' },
    // 1.2 pre-releases installed the skills-directory plugin under ~/.claude/skills/jevris.
    { name: 'claude-install-receipt.json', pluginId: 'jevris@skills-dir' },
    { name: 'install-receipt.json', pluginId: 'jevris@skills-dir' },
  ],
  kilocode: [
    { name: 'kilocode-install-receipt.json', pluginId: 'jevris@kilo-plugin' },
    { name: 'kilocode-interface-receipt.json', pluginId: 'jevris@kilocode-interface' },
  ],
  codex: [
    { name: 'codex-install-receipt.json', pluginId: 'jevris@codex' },
    { name: 'codex-interface-receipt.json', pluginId: 'jevris@codex-interface' },
  ],
  opencode: [
    { name: 'opencode-install-receipt.json', pluginId: 'jevris@opencode' },
    { name: 'opencode-interface-receipt.json', pluginId: 'jevris@opencode-interface' },
  ],
  antigravity: [{ name: 'antigravity-install-receipt.json', pluginId: 'jevris@antigravity-plugin' }],
};

/** The install-time line of the generated Kilo and OpenCode shims (D-F4). */
export const RUNTIME_LINE = 'const JEVRIS_RUNTIME = null;';
/**
 * SKL-03: the Claude plugin lives in a local marketplace under ~/.claude/plugins, not in
 * ~/.claude/skills. OpenCode also reads every SKILL.md under ~/.claude/skills, so a plugin there
 * would show every Jevris skill twice in OpenCode, with Claude's tool names.
 */
export const CLAUDE_MARKETPLACE = 'jevris-local';
export const CLAUDE_PLUGIN_ID = `jevris@${CLAUDE_MARKETPLACE}`;
export const LEGACY_CLAUDE_PLUGIN_ID = 'jevris@skills-dir';
/** Home-relative marketplace folder; the plugin is `plugins/jevris` inside it. */
export const CLAUDE_MARKETPLACE_REL = join('.claude', 'plugins', CLAUDE_MARKETPLACE);
export const CODEX_MARKETPLACE_DEFAULT = 'jevris-local';
/** One skill per public command (SKL-01); `status` is required, the others ship as the package has them. */
const SKILL_NAMES: readonly string[] = PUBLIC_COMMAND_NAMES;
/** The one skill source, package-relative; every harness's tree is rendered from it at install. */
const SKILL_SOURCE = ['plugins', 'shared', 'skills'];
const MAX_CONFIG = 131072;

// ---------------------------------------------------------------------------
// Types shared with admin-cli and doctor.

export interface PlannedChange {
  readonly harness: GlobalHarness | 'runtime';
  readonly action: 'create' | 'replace' | 'edit' | 'strip' | 'delete' | 'keep' | 'run' | 'copy';
  /** Home-relative, forward slashes. */
  readonly path: string;
  readonly detail: string;
}

export interface HarnessCli {
  /** Runs a harness CLI with shell false and a bounded time. `spawned: false` when unavailable. */
  run(
    file: string,
    args: readonly string[],
    timeoutMs: number,
    env?: { readonly [key: string]: string | undefined },
    /** The working directory; default this process's. A certify case that runs a model turn uses an empty folder in the profile. */
    options?: { readonly cwd?: string },
  ): Promise<{ readonly spawned: boolean; readonly code: number; readonly stdout: string; readonly stderr?: string }>;
  /** True when the binary is on PATH and may be started (never in tests). */
  available(file: string): boolean;
}

function definedEnv(env: { readonly [key: string]: string | undefined }): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

/** Runs a harness CLI with shell false, in its own process group, killed as a tree at the deadline. */
/**
 * The environment a harness binary is looked up and run with. The Antigravity CLI installer
 * puts `agy` in ~/.local/bin on macOS and Linux and in %LOCALAPPDATA%\agy\bin on Windows
 * (antigravity.google/docs/cli/install), which is not always on PATH (AGY-06), so that folder is
 * searched after PATH. The folder comes from `discovery` (this process's own environment): a
 * certify run hands the harness a temporary HOME and LOCALAPPDATA, but the binary is where the
 * user installed it. Everything else is unchanged.
 */
export function harnessExecutableEnv(
  file: string,
  env: { readonly [key: string]: string | undefined },
  platform: string = process.platform,
  discovery: { readonly [key: string]: string | undefined } = env,
): { readonly [key: string]: string | undefined } {
  if (file !== 'agy') return env;
  let extra: string;
  if (platform === 'win32') {
    const local = discovery['LOCALAPPDATA'] ?? discovery['LocalAppData'];
    if (typeof local !== 'string' || local.length === 0) return env;
    extra = win32.join(local, 'agy', 'bin');
  } else {
    const home = discovery['HOME'];
    if (typeof home !== 'string' || home.length === 0) return env;
    extra = posix.join(home, '.local', 'bin');
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[pathKey] ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  if (current.split(separator).includes(extra)) return env;
  return { ...env, [pathKey]: current.length > 0 ? `${current}${separator}${extra}` : extra };
}

export async function runHarnessCli(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: { readonly [key: string]: string | undefined },
  options: { readonly cwd?: string } = {},
): Promise<{ readonly spawned: boolean; readonly code: number; readonly stdout: string; readonly stderr?: string }> {
  if (env === undefined && options.cwd === undefined && harnessExecutableEnv(file, process.env) === process.env) return runBounded(file, args, timeoutMs);
  // stderr too: some status commands print there (`codex login status`). With a working
  // directory, PWD names it too: Kilo's and OpenCode's `run` take their directory from PWD, not the
  // process cwd (run.ts: `process.env.PWD ?? process.cwd()`), and a spawned child inherits the
  // caller's PWD unchanged. Without it a certify case's turn ran in the folder certify started in
  // (the owner's run, 2026-09-28: ROOTS_OUTSIDE_CASE), as opencode-worker.ts already guards.
  const executableEnv = harnessExecutableEnv(file, env ?? process.env, process.platform, process.env);
  const runEnv = options.cwd === undefined ? executableEnv : { ...executableEnv, PWD: options.cwd };
  const launched = launchTree(file, args, { captureStdout: true, captureStderr: true, env: definedEnv(runEnv), ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    launched.kill();
  }, timeoutMs);
  const exit = await launched.done;
  clearTimeout(timer);
  const stdout = timedOut ? '' : await launched.stdout;
  const stderr = timedOut ? '' : await launched.stderr;
  if (!exit.spawned) return { spawned: false, code: 1, stdout: '' };
  return { spawned: true, code: timedOut ? 124 : (exit.code ?? 1), stdout, stderr };
}

export const defaultHarnessCli: HarnessCli = {
  run: runHarnessCli,
  available: (file) => liveHarnessAllowed() && resolveExecutable(file, { env: harnessExecutableEnv(file, process.env) }) !== null,
};

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

export interface OperationReport extends InstallResult {
  readonly status: 'installed' | 'planned' | 'removed' | 'refused' | 'restored';
  readonly changes: readonly PlannedChange[];
  readonly runtime: { readonly dir: string; readonly version: string } | null;
  readonly smoke: readonly SmokeResult[];
  readonly nextSteps: readonly string[];
  /** One sentence that says what went wrong and what to do. */
  readonly error: string | null;
  readonly conflicts: readonly string[];
  readonly backup: string | null;
}

export interface InstallOptions {
  readonly home: string;
  /** The installed package root (where dist/runtime/manifest.json lives). */
  readonly root: string;
  readonly platform?: string;
  readonly harness?: GlobalHarness;
  readonly dryRun?: boolean;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly cli?: HarnessCli;
  /** false skips the post-install smoke (tests of the file layout only). */
  readonly smoke?: boolean;
  readonly afterConfigRead?: (path: string) => void | Promise<void>;
  /** Legacy: accepted for compatibility with older callers; Claude is enabled by default. */
  readonly enable?: boolean;
  readonly source?: string;
  readonly afterSettingsRead?: () => void | Promise<void>;
  /**
   * The HOME the harness CLIs run with, when it is not the install home. Only certify on macOS
   * sets it (for Claude Code), to the account's own home: Claude Code finds its login keychain
   * through HOME, and under a temp HOME macOS shows "A keychain cannot be found". Its config
   * folder (CLAUDE_CONFIG_DIR) stays inside the install home. Any other value is ignored.
   */
  readonly harnessHome?: string;
  /** The Node.js the `jevris` launcher runs (default: the one running install). */
  readonly node?: string;
}

interface Ctx {
  readonly pair: HomePair;
  readonly dataRoot: string;
  readonly runtimeDir: string;
  /** Where plan content is read: the runtime copy, or the package itself in a dry run. */
  readonly readRoot: string;
  readonly manifest: RuntimeManifest;
  readonly platform: string;
  readonly env: { readonly [key: string]: string | undefined };
  readonly cli: HarnessCli;
  /** See InstallOptions.harnessHome; null means the install home. */
  readonly harnessHome: string | null;
  readonly dryRun: boolean;
  readonly changes: PlannedChange[];
  readonly nextSteps: string[];
}

function rel(pair: HomePair, abs: string): string {
  const out = abs.startsWith(pair.resolvedHome) ? abs.slice(pair.resolvedHome.length) : abs;
  return out.replace(/^[/\\]+/, '').split(/[/\\]/).join('/');
}

/** Steps named by their action and path alone: a second one for the same path is the same step. */
const PATH_STEPS: ReadonlySet<PlannedChange['action']> = new Set(['create', 'replace', 'delete', 'keep', 'copy']);

/**
 * Adds one step to the plan. A path two sources plan the same way (two old receipts, or an old
 * receipt and the unlisted v1.1 paths, naming one folder) is listed once, with the first
 * reason. Edits, strips and commands are the same step only when their detail matches too.
 */
function note(ctx: Ctx, harness: PlannedChange['harness'], action: PlannedChange['action'], abs: string, detail: string): void {
  const path = rel(ctx.pair, abs);
  const same = (change: PlannedChange): boolean => change.harness === harness && change.action === action && change.path === path && (PATH_STEPS.has(action) || change.detail === detail);
  if (ctx.changes.some(same)) return;
  ctx.changes.push({ harness, action, path, detail });
}

class PlanError extends Error {}

function fail(message: string): never {
  throw new PlanError(message);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string, cap = MAX_CONFIG): Promise<string | null> {
  const bytes = await readBytes(path);
  if (bytes === null || bytes === 'error' || bytes.byteLength > cap) return null;
  return decodeText(bytes) ?? null;
}

async function bounded(pair: HomePair, relPath: string): Promise<string> {
  const abs = await boundedPath(pair, relPath);
  if (abs === null) fail(`${relPath} resolves outside the home (a symlink leaves it); fix the link and retry`);
  return abs;
}

/** A per-harness config root under the home: an env override inside the home, else the default. */
function envDir(pair: HomePair, env: Ctx['env'], name: string, fallback: string): string {
  const value = env[name];
  if (typeof value === 'string' && value.length > 0 && insideHome(pair, value)) return rel(pair, value);
  return fallback;
}

function configRel(ctx: Ctx): string {
  return envDir(ctx.pair, ctx.env, 'XDG_CONFIG_HOME', '.config');
}

function codexRel(ctx: Ctx): string {
  return envDir(ctx.pair, ctx.env, 'CODEX_HOME', '.codex');
}

function forwardSlashes(path: string): string {
  return path.split('\\').join('/');
}

function entry(ctx: Ctx, key: string): string {
  const abs = runtimeEntry(ctx.runtimeDir, ctx.manifest, key);
  if (abs === null) fail(`the runtime manifest has no ${key} entry; reinstall the package`);
  return abs;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Skills: copied from the runtime, namespaced where the harness has one flat skill folder.

/**
 * The harness's own manifest in the runtime, plugins/<harness>/harness.json: where its plugin,
 * skills and MCP entry go. Every install step for that harness reads its places from here.
 */
async function harnessManifest(ctx: Ctx, harness: GlobalHarness): Promise<HarnessManifest> {
  const text = await readText(join(ctx.readRoot, 'plugins', harness, 'harness.json'));
  const parsed = text === null ? { manifest: null, problem: 'missing' } : parseHarnessManifest(text, harness);
  if (parsed.manifest === null) fail(`the runtime's ${harness} harness manifest (harness.json) is invalid (${parsed.problem ?? 'unknown'}); reinstall the package`);
  return parsed.manifest;
}

/** A manifest path, home-relative, with `$CONFIG` and `$CODEX_HOME` resolved inside the home. */
function manifestRel(ctx: Ctx, path: string): string {
  const [head = '', ...rest] = path.split('/');
  const base = head === '$CONFIG' ? configRel(ctx) : head === '$CODEX_HOME' ? codexRel(ctx) : head;
  return join(base, ...rest);
}

async function skillEntries(ctx: Ctx): Promise<readonly SkillEntry[]> {
  let entries: readonly SkillEntry[];
  try {
    entries = await readSkillSources(join(ctx.readRoot, ...SKILL_SOURCE));
  } catch (error) {
    fail(`the runtime skill source is invalid (${error instanceof Error ? error.message : String(error)}); reinstall the package`);
  }
  const shipped = entries.filter((item) => SKILL_NAMES.includes(item.skill.name));
  if (!shipped.some((item) => item.skill.name === 'status')) fail('the runtime is missing skill status; reinstall the package');
  return shipped;
}

/**
 * Renders the harness's skill tree from the one shared source into the manifest's skills
 * folder, with the manifest's skill profile (SKL-01, SKL-02).
 */
async function copySkills(txn: InstallTxn, ctx: Ctx, manifest: HarnessManifest): Promise<void> {
  const to = await bounded(ctx.pair, manifestRel(ctx, manifest.skills.dir));
  for (const [path, text] of renderSkillTree(await skillEntries(ctx), skillProfile(manifest, `the ${manifest.harness} harness manifest`))) {
    await own(txn, ctx, manifest.harness, join(to, ...path.split('/')), text);
  }
}

async function own(txn: InstallTxn, ctx: Ctx, harness: GlobalHarness, abs: string, data: string | Uint8Array): Promise<void> {
  const before = await readBytes(abs);
  if (!(await txn.writeOwned(abs, data))) {
    fail(`${rel(ctx.pair, abs)} exists and is not Jevris's; move it aside and retry`);
  }
  if (ctx.dryRun) note(ctx, harness, before === null ? 'create' : 'replace', abs, 'Jevris file');
}

async function edit(
  txn: InstallTxn,
  ctx: Ctx,
  harness: GlobalHarness,
  abs: string,
  plan: Parameters<InstallTxn['planEdit']>[1],
  detail: string,
): Promise<void> {
  if (!(await txn.planEdit(abs, plan))) {
    fail(`${rel(ctx.pair, abs)} could not be read as ${plan.format.toUpperCase()} or changed while Jevris read it; fix the file and retry`);
  }
  note(ctx, harness, 'edit', abs, detail);
}

function jsonKeyPlan(path: readonly string[], value: unknown, template = '{}\n') {
  return {
    format: 'json' as const,
    strip: { kind: 'json-key' as const, path },
    template,
    apply: (base: string) => applyJsonKey(base, path, value),
    pointer: `/${path.join('/')}`,
  };
}

async function preferJsonc(pair: HomePair, dirRel: string, name: string): Promise<string> {
  const jsonc = await bounded(pair, join(dirRel, `${name}.jsonc`));
  if (await exists(jsonc)) return jsonc;
  return bounded(pair, join(dirRel, `${name}.json`));
}

// ---------------------------------------------------------------------------
// Claude Code: a local marketplace plugin (`jevris@jevris-local`, SKL-03) under
// ~/.claude/plugins/jevris-local, with its hooks and MCP pointed at the runtime copy, the
// marketplace declared and the plugin enabled in user settings.

/**
 * Points the Claude plugin's hooks and MCP at the runtime's own entries, the same hook
 * launcher and MCP server every harness runs; the plugin carries no copy of either. Null when
 * a `${CLAUDE_PLUGIN_ROOT}` reference other than those two is left.
 */
export function pointAtRuntime(text: string, entries: { readonly hook: string; readonly mcp: string }): string | null {
  const json = (path: string): string => JSON.stringify(forwardSlashes(path)).slice(1, -1);
  const out = text
    .split('${CLAUDE_PLUGIN_ROOT}/bin/hook.js')
    .join(json(entries.hook))
    .split('${CLAUDE_PLUGIN_ROOT}/bin/mcp.js')
    .join(json(entries.mcp));
  return out.includes('${CLAUDE_PLUGIN_ROOT}') ? null : out;
}

/**
 * The certification feature each gated Claude event waits on. The plugin's hooks.json never lists
 * a gated event; install adds it only when a record certifies that feature for the installed
 * binary (StopFailure: access.session, K19; B's MEDIUM 26 on access limits R68).
 */
export const CLAUDE_GATED_HOOKS: Readonly<Record<keyof typeof CLAUDE_GATED_EVENTS, CertificationFeature>> = { StopFailure: 'access.session' };

/**
 * The Claude plugin's hooks.json with each certified gated event added, registered as the plugin
 * registers Stop (the same launcher, arguments and timeout). Null when the text has no Stop entry.
 */
export function withGatedClaudeHooks(text: string, events: readonly string[]): string | null {
  if (events.length === 0) return text;
  let parsed: { hooks?: { [event: string]: unknown } };
  try {
    parsed = JSON.parse(text) as { hooks?: { [event: string]: unknown } };
  } catch {
    return null;
  }
  const stop = parsed.hooks?.['Stop'];
  if (parsed.hooks === undefined || !Array.isArray(stop)) return null;
  const hooks: { [event: string]: unknown } = { ...parsed.hooks };
  for (const event of events) hooks[event] = JSON.parse(JSON.stringify(stop)) as unknown;
  return `${JSON.stringify({ ...parsed, hooks }, null, 2)}\n`;
}

/** Package metadata a plugin manifest carries: author, license and homepage (CLA-01, CDX-01). */
export interface PluginMetadata {
  readonly author?: string;
  readonly license?: string;
  readonly homepage?: string;
}

/** Reads the metadata once from the runtime's own package.json, so no manifest repeats it. */
async function pluginMetadata(ctx: Ctx): Promise<PluginMetadata> {
  const text = await readText(join(ctx.readRoot, 'package.json'));
  if (text === null) return {};
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const pick = (key: string): string | undefined => {
      const value = pkg[key];
      return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
    };
    const author = pick('author');
    const license = pick('license');
    const homepage = pick('homepage');
    return { ...(author === undefined ? {} : { author }), ...(license === undefined ? {} : { license }), ...(homepage === undefined ? {} : { homepage }) };
  } catch {
    return {};
  }
}

/**
 * A plugin manifest with the runtime version, so the harness re-caches the plugin on upgrade,
 * and the package's author, license and homepage. Null unless it is a Jevris manifest.
 */
export function pluginManifest(text: string, version: string, metadata: PluginMetadata = {}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const manifest = parsed as Record<string, unknown>;
  if (manifest.name !== 'jevris') return null;
  return jsonText({
    ...manifest,
    version,
    ...(metadata.author === undefined ? {} : { author: { name: metadata.author } }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
  });
}


export function claudeMarketplaceJson(version: string): string {
  return jsonText({
    name: CLAUDE_MARKETPLACE,
    owner: { name: 'Jevris' },
    description: 'Jevris, installed on this machine by jevris install. Removed by jevris uninstall.',
    plugins: [{ name: 'jevris', source: './plugins/jevris', description: 'Jevris routing, planning and verification (observe mode until certified).', version }],
  });
}

async function planClaude(txn: InstallTxn, ctx: Ctx, gated: readonly string[]): Promise<void> {
  const pair = ctx.pair;
  const manifestFile = await harnessManifest(ctx, 'claude');
  const market = await bounded(pair, CLAUDE_MARKETPLACE_REL);
  // The marketplace entry names the plugin at ./plugins/jevris; the manifest must agree.
  if (manifestRel(ctx, manifestFile.plugin.path) !== join(CLAUDE_MARKETPLACE_REL, 'plugins', 'jevris')) fail('the runtime Claude harness manifest names another plugin folder; reinstall the package');
  const dest = await bounded(pair, manifestRel(ctx, manifestFile.plugin.path));
  const settings = await bounded(pair, join('.claude', 'settings.json'));
  const source = join(ctx.readRoot, 'plugins', 'claude');
  const runtimeEntries = { hook: entry(ctx, 'hook'), mcp: entry(ctx, 'mcp') };
  // ADM-07: the plugin's hooks are scanned before anything points at them.
  if (!(await scanHooks(source)).accepted) fail('the Claude plugin hooks did not pass the safety scan (shell, inline code, a long timeout or a bad manifest); reinstall the package');
  const manifestText = await readText(join(source, '.claude-plugin', 'plugin.json'));
  const manifest = manifestText === null ? null : pluginManifest(manifestText, ctx.manifest.version, await pluginMetadata(ctx));
  if (manifest === null) fail('the runtime has no valid Claude plugin manifest; reinstall the package');
  await own(txn, ctx, 'claude', join(market, '.claude-plugin', 'marketplace.json'), claudeMarketplaceJson(ctx.manifest.version));
  await own(txn, ctx, 'claude', join(dest, '.claude-plugin', 'plugin.json'), manifest);
  for (const file of [join('hooks', 'hooks.json'), '.mcp.json']) {
    const read = await readText(join(source, file));
    const text = read === null || file !== join('hooks', 'hooks.json') ? read : withGatedClaudeHooks(read, gated);
    const pointed = text === null ? null : pointAtRuntime(text, runtimeEntries);
    if (pointed === null) fail(`the runtime Claude plugin ${forwardSlashes(file)} is missing or names an unknown plugin file; reinstall the package`);
    await own(txn, ctx, 'claude', join(dest, file), pointed);
  }
  await copySkills(txn, ctx, manifestFile);
  const marketKey = ['extraKnownMarketplaces', CLAUDE_MARKETPLACE];
  const enableKey = ['enabledPlugins', CLAUDE_PLUGIN_ID];
  await edit(
    txn,
    ctx,
    'claude',
    settings,
    {
      format: 'json',
      strip: { kind: 'json-keys', keys: [{ path: marketKey }, { path: enableKey }] },
      template: '{}\n',
      apply: (base) =>
        applyJsonKeys(base, [
          [marketKey, { source: { source: 'directory', path: market } }],
          [enableKey, true],
        ]),
      pointer: `/${marketKey.join('/')}, /${enableKey.join('/')}`,
    },
    `extraKnownMarketplaces["${CLAUDE_MARKETPLACE}"] and enabledPlugins["${CLAUDE_PLUGIN_ID}"] = true`,
  );
}

// ---------------------------------------------------------------------------
// Kilo and OpenCode: a generated JS plugin with the runtime line substituted, an MCP entry
// in kilo.json[c] / opencode.json[c], and namespaced skills.

export function substituteShim(text: string, launcher: string): string | null {
  const lines = text.split('\n');
  const at = lines.flatMap((line, index) => (line === RUNTIME_LINE ? [index] : []));
  if (at.length !== 1) return null;
  lines[at[0] ?? 0] = `const JEVRIS_RUNTIME = ${JSON.stringify({ node: 'node', launcher })};`;
  return lines.join('\n');
}

async function planShimHarness(txn: InstallTxn, ctx: Ctx, harness: 'kilocode' | 'opencode'): Promise<void> {
  const pair = ctx.pair;
  // Every place comes from the harness's manifest, plugins/<harness>/harness.json.
  const manifest = await harnessManifest(ctx, harness);
  const mcp = manifest.mcp;
  const template = manifest.plugin.template;
  const exportForm = manifest.plugin.export;
  if (mcp === undefined || template === undefined || exportForm === undefined) fail(`the runtime's ${harness} harness manifest has no plugin template or MCP entry; reinstall the package`);
  const plugin = await bounded(pair, manifestRel(ctx, manifest.plugin.path));
  const configFile = await preferJsonc(pair, manifestRel(ctx, mcp.dir), mcp.file);
  const shimTemplate = await readText(join(ctx.readRoot, ...template.split('/')), 262144);
  const shim = shimTemplate === null ? null : renderShimPlugin(shimTemplate, { harness, launcher: manifest.launcher, exportForm });
  if (shim === null) fail(`the runtime has no valid ${harness} plugin template; reinstall the package`);
  const substituted = substituteShim(shim, entry(ctx, 'hook'));
  if (substituted === null) fail(`the ${harness} plugin in the runtime has no runtime line; reinstall the package`);
  await own(txn, ctx, harness, plugin, substituted);
  const server = mcpEntry(mcp.entry, entry(ctx, 'mcp'));
  const configTemplate = mcp.schema === null ? '{}\n' : `${JSON.stringify({ $schema: mcp.schema }, null, 2)}\n`;
  await edit(txn, ctx, harness, configFile, jsonKeyPlan(mcp.key, server, configTemplate), `${mcp.key.join('.')} (local MCP server)`);
  await copySkills(txn, ctx, manifest);
}

// ---------------------------------------------------------------------------
// Codex: a portable plugin in the personal marketplace, enabled in config.toml.

/** Absolute, cwd-independent Codex hook commands for POSIX shells and for Windows. */
export function codexHookCommands(hookPath: string, harnessArgs: readonly string[] = []): { command: string; commandWindows: string } | null {
  const forward = forwardSlashes(hookPath);
  if (/['"%\r\n\0]/.test(hookPath) || harnessArgs.some((arg) => !/^[A-Za-z0-9_-]+$/.test(arg))) return null;
  const tail = harnessArgs.length > 0 ? ` ${harnessArgs.join(' ')}` : '';
  return { command: `node '${forward}'${tail}`, commandWindows: `node "${hookPath.split('/').join('\\')}"${tail}` };
}

/**
 * The plugin's hooks/hooks.json: every registered Codex event, with explicit short timeouts.
 * `commandWindows` is written only for a Windows install: on POSIX the hook path is a POSIX
 * path, and a backslash form of it names no file anywhere.
 */
export function codexHooksJson(hookPath: string, platform: string = process.platform): string {
  const commands = codexHookCommands(hookPath, ['--harness', 'codex']);
  if (commands === null) fail('the runtime path contains a quote or percent sign; install to a plainer home path');
  const hooks: Record<string, unknown> = {};
  for (const event of CODEX_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: 'command',
            command: commands.command,
            ...(platform === 'win32' ? { commandWindows: commands.commandWindows } : {}),
            timeout: CODEX_TIMEOUTS[event],
          },
        ],
      },
    ];
  }
  return jsonText({ hooks });
}

export function codexMcpJson(mcpPath: string): string {
  return jsonText({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { jevris: { type: 'stdio', command: 'node', args: [mcpPath, '--harness', 'codex'] } },
  });
}

async function codexMarketplaceName(path: string): Promise<string> {
  const text = await readText(path);
  if (text === null || text.trim().length === 0) return CODEX_MARKETPLACE_DEFAULT;
  const root = parseJsoncTree(text);
  if (root === null) fail(`${basename(path)} is not valid JSON; fix it and retry`);
  const node = findNode(root, ['name']);
  const name = node === undefined ? undefined : nodeValue(node);
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : CODEX_MARKETPLACE_DEFAULT;
}

async function planCodex(txn: InstallTxn, ctx: Ctx): Promise<{ marketplace: string }> {
  const pair = ctx.pair;
  const codex = codexRel(ctx);
  const harness = await harnessManifest(ctx, 'codex');
  const plugin = await bounded(pair, manifestRel(ctx, harness.plugin.path));
  const market = await bounded(pair, join('.agents', 'plugins', 'marketplace.json'));
  const configToml = await bounded(pair, join(codex, 'config.toml'));
  const marketplace = await codexMarketplaceName(market);
  const source = join(ctx.readRoot, 'plugins', 'codex', 'plugin');
  const manifestText = await readText(join(source, 'plugin.json'));
  const manifest = manifestText === null ? null : pluginManifest(manifestText, ctx.manifest.version, await pluginMetadata(ctx));
  if (manifest === null) fail('the runtime has no Codex plugin manifest; reinstall the package');
  await own(txn, ctx, 'codex', join(plugin, 'plugin.json'), manifest);
  await own(txn, ctx, 'codex', join(plugin, 'mcp.json'), codexMcpJson(entry(ctx, 'mcp')));
  await own(txn, ctx, 'codex', join(plugin, 'hooks', 'hooks.json'), codexHooksJson(entry(ctx, 'hook'), ctx.platform));
  await copySkills(txn, ctx, harness);
  const marketEntry = {
    name: 'jevris',
    source: { source: 'local', path: `./${rel(pair, plugin)}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  await edit(
    txn,
    ctx,
    'codex',
    market,
    {
      format: 'json',
      strip: { kind: 'json-array-name', path: ['plugins'], name: 'jevris' },
      template: jsonText({ name: CODEX_MARKETPLACE_DEFAULT, interface: { displayName: 'Jevris (local)' }, plugins: [] }),
      apply: (base) => applyArrayEntry(base, ['plugins'], marketEntry),
      pointer: '/plugins',
    },
    `plugin entry "jevris" in marketplace ${marketplace}`,
  );
  const table = ['plugins', `jevris@${marketplace}`];
  await edit(
    txn,
    ctx,
    'codex',
    configToml,
    {
      format: 'toml',
      strip: { kind: 'toml-table', table },
      template: '',
      apply: (base) => {
        const appended = appendTomlBlock(base, [`[plugins.${tomlString(`jevris@${marketplace}`)}]`, 'enabled = true']);
        return { text: appended.text, splices: [appended.splice] };
      },
      table: table.join('.'),
    },
    `[plugins."jevris@${marketplace}"] enabled = true`,
  );
  return { marketplace };
}

// ---------------------------------------------------------------------------
// Antigravity: the documented global plugin location, with its own mcp_config.json and a
// named hook group that stays disabled until a certification record covers it (AGY-03).
// PreToolUse is never registered (decision D-F1).

export function antigravityHooksJson(hookPath: string, enabled: boolean): string {
  const quoted = `"${hookPath}"`;
  if (/["%\r\n\0]/.test(hookPath)) fail('the runtime path contains a quote or percent sign; install to a plainer home path');
  const group: Record<string, unknown> = { enabled };
  for (const event of AGY_EVENTS) {
    const handler = { type: 'command', command: `node ${quoted} --harness agy --event ${event}`, timeout: AGY_TIMEOUTS[event] };
    group[event] = event === 'PostToolUse' ? [{ matcher: '.*', hooks: [handler] }] : [handler];
  }
  return jsonText({ 'jevris-observe': group });
}

export function antigravityMcpJson(mcpPath: string): string {
  return jsonText({ mcpServers: { jevris: { command: 'node', args: [mcpPath, '--harness', 'antigravity'] } } });
}

async function planAntigravity(txn: InstallTxn, ctx: Ctx, hooksCertified: boolean): Promise<void> {
  const pair = ctx.pair;
  const harness = await harnessManifest(ctx, 'antigravity');
  const plugin = await bounded(pair, manifestRel(ctx, harness.plugin.path));
  const source = join(ctx.readRoot, 'plugins', 'antigravity');
  const manifest = await readText(join(source, 'plugin.json'));
  if (manifest === null) fail('the runtime has no Antigravity plugin manifest; reinstall the package');
  await own(txn, ctx, 'antigravity', join(plugin, 'plugin.json'), manifest);
  await own(txn, ctx, 'antigravity', join(plugin, 'mcp_config.json'), antigravityMcpJson(entry(ctx, 'mcp')));
  await own(txn, ctx, 'antigravity', join(plugin, 'hooks.json'), antigravityHooksJson(entry(ctx, 'hook'), hooksCertified));
  await copySkills(txn, ctx, harness);
}

// ---------------------------------------------------------------------------
// Legacy v1.x migration. A v1 receipt listed whole paths; some installs also wrote
// namespaced keys they never listed. Removed here: only `jevris` keys and entries whose
// value names a Jevris path, Jevris handlers in shared hook files, and listed files whose
// bytes carry a Jevris signature. Everything else stays, byte for byte.

const LEGACY_SIGNATURES = [/jevris/i, /Installed is not enforced/];
const MODULE_MARKER = '{"type":"module"}\n';

function mentionsJevris(value: unknown): boolean {
  return JSON.stringify(value ?? null).toLowerCase().includes('jevris');
}

interface Strip {
  readonly harness: GlobalHarness;
  readonly rel: string;
  readonly spec: StripSpec;
  readonly detail: string;
  /** Strip only when the value at this JSON path names Jevris. */
  readonly guard?: readonly string[];
}

function legacyStrips(ctx: Ctx, harness: GlobalHarness): Strip[] {
  const config = configRel(ctx);
  const codex = codexRel(ctx);
  switch (harness) {
    case 'kilocode':
      return ['kilo.json', 'kilo.jsonc'].map((name) => ({
        harness,
        rel: join(config, 'kilo', name),
        spec: { kind: 'json-key', path: ['mcp', 'jevris'] },
        detail: 'legacy mcp.jevris',
        guard: ['mcp', 'jevris'],
      }));
    case 'opencode':
      return ['opencode.json', 'opencode.jsonc'].map((name) => ({
        harness,
        rel: join(config, 'opencode', name),
        spec: { kind: 'json-key', path: ['mcp', 'jevris'] },
        detail: 'legacy mcp.jevris',
        guard: ['mcp', 'jevris'],
      }));
    case 'codex':
      return [
        { harness, rel: join(codex, 'config.toml'), spec: { kind: 'toml-table', table: ['mcp_servers', 'jevris'] }, detail: 'legacy [mcp_servers.jevris] (the plugin provides MCP)' },
        { harness, rel: join(codex, 'hooks.json'), spec: { kind: 'codex-hooks' }, detail: 'legacy Jevris hook handlers' },
      ];
    case 'antigravity':
      return [
        {
          harness,
          rel: join('.gemini', 'config', 'mcp_config.json'),
          spec: { kind: 'json-key', path: ['mcpServers', 'jevris'] },
          detail: 'legacy global mcpServers.jevris (the plugin provides MCP)',
          guard: ['mcpServers', 'jevris'],
        },
      ];
    default:
      return [];
  }
}

async function applyStrip(ctx: Ctx, strip: Strip, hooks: TxnHooks): Promise<void> {
  const abs = await bounded(ctx.pair, strip.rel);
  const bytes = await readBytes(abs);
  if (bytes === null) return;
  if (bytes === 'error' || bytes.byteLength > MAX_CONFIG) fail(`${strip.rel} could not be read; check its permissions and retry`);
  const text = decodeText(bytes);
  if (text === undefined) fail(`${strip.rel} is not UTF-8 text; fix it and retry`);
  if (hooks.afterConfigRead !== undefined) await hooks.afterConfigRead(abs);
  if (strip.spec.kind === 'toml-table' && !hasTomlTable(text, strip.spec.table)) return;
  if (strip.guard !== undefined) {
    const root = parseJsoncTree(text);
    if (root === null) return;
    const node = findNode(root, strip.guard);
    if (node === undefined || !mentionsJevris(nodeValue(node))) return;
  }
  const stripped = stripText(text, strip.spec);
  if (stripped === null) fail(`${strip.rel} could not be parsed to remove the old Jevris entry; fix the file and retry`);
  if (stripped === text) return;
  note(ctx, strip.harness, 'strip', abs, strip.detail);
  if (ctx.dryRun) return;
  if (!(await casWrite(abs, sha256(bytes), stripped))) fail(`${strip.rel} changed while Jevris edited it; retry`);
}

/** True when a listed legacy file carries a Jevris signature and may be removed. */
async function legacyFileIsOurs(path: string): Promise<boolean> {
  const name = basename(path);
  const bytes = await readBytes(path);
  if (bytes === null || bytes === 'error') return false;
  if (name === 'package.json') return decodeText(bytes) === MODULE_MARKER;
  if (bytes.byteLength > 1048576) return false;
  const text = decodeText(bytes);
  if (text === undefined) return false;
  return LEGACY_SIGNATURES.some((pattern) => pattern.test(text));
}

async function listTree(dir: string, out: string[], depth = 0): Promise<boolean> {
  if (depth > 12 || out.length > 5000) return false;
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    const path = join(dir, name);
    const st = await lstat(path);
    if (st.isSymbolicLink()) return false;
    if (st.isDirectory()) {
      if (!(await listTree(path, out, depth + 1))) return false;
    } else out.push(path);
  }
  return true;
}

/** A directory Jevris wrote: named jevris or a hook vendor tree, holding a Jevris manifest or vendor core. */
async function legacyDirIsOurs(dir: string): Promise<boolean> {
  for (const marker of [join(dir, 'plugin.json'), join(dir, '.claude-plugin', 'plugin.json')]) {
    const text = await readText(marker);
    if (text !== null && /"name"\s*:\s*"jevris"/.test(text)) return true;
  }
  if (basename(dir) === 'vendor' && (await exists(join(dir, 'core', 'hook-adapter.js')))) return true;
  return false;
}

async function removeLegacyPath(ctx: Ctx, harness: GlobalHarness, path: string, kept: string[]): Promise<void> {
  if (!insideHome(ctx.pair, path)) return;
  let st;
  try {
    st = await lstat(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (!(await legacyDirIsOurs(path))) {
      kept.push(path);
      note(ctx, harness, 'keep', path, 'listed by an old receipt but not recognisably Jevris; left in place');
      return;
    }
    const files: string[] = [];
    if (!(await listTree(path, files))) fail(`${rel(ctx.pair, path)} could not be listed; remove it by hand`);
    note(ctx, harness, 'delete', path, 'old Jevris folder');
    if (ctx.dryRun) return;
    for (const file of files) {
      const bytes = await readBytes(file);
      if (bytes === null || bytes === 'error') continue;
      if (!(await casDelete(file, sha256(bytes)))) fail(`${rel(ctx.pair, file)} could not be removed; check permissions`);
    }
    await removeEmptyTree(path);
    return;
  }
  if (!(await legacyFileIsOurs(path))) {
    kept.push(path);
    note(ctx, harness, 'keep', path, 'listed by an old receipt but not recognisably Jevris; left in place');
    return;
  }
  note(ctx, harness, 'delete', path, 'old Jevris file');
  if (ctx.dryRun) return;
  const bytes = await readBytes(path);
  if (bytes === null || bytes === 'error') return;
  if (!(await casDelete(path, sha256(bytes)))) fail(`${rel(ctx.pair, path)} could not be removed; check permissions`);
  await removeEmptyParents(ctx.pair, dirname(path));
}

/** Folders a harness or the user shares; an old Jevris file's empty parents are removed up to one of these. */
const SHARED_DIR_NAMES = new Set(['skills', 'skill', 'plugins', 'plugin', 'hooks', 'config', '.config', '.kilo', '.kilocode', '.claude', '.codex', '.gemini', '.agents', 'opencode', 'kilo', 'antigravity-cli']);

async function removeEmptyParents(pair: HomePair, start: string): Promise<void> {
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!insideHome(pair, dir) || rel(pair, dir) === '' || SHARED_DIR_NAMES.has(basename(dir))) return;
    try {
      await rmdir(dir);
      currentJournal()?.dirRemoved(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

async function removeEmptyTree(dir: string): Promise<void> {
  const dirs: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    dirs.push(current);
    let names: readonly string[] = [];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(current, name);
      try {
        if ((await lstat(path)).isDirectory()) await walk(path, depth + 1);
      } catch {
        continue;
      }
    }
  };
  await walk(dir, 0);
  for (const path of dirs.sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(path);
      currentJournal()?.dirRemoved(path);
    } catch {
      continue;
    }
  }
}

/** Legacy locations earlier versions wrote without listing: removed only with a Jevris signature. */
function legacyUnlisted(ctx: Ctx, harness: GlobalHarness): string[] {
  const config = configRel(ctx);
  switch (harness) {
    case 'kilocode':
      return [join('.kilo', 'plugin', 'jevris.js'), join(config, 'kilo', 'jevris')];
    case 'opencode':
      return [join(config, 'opencode', 'jevris')];
    case 'codex':
      return [join(codexRel(ctx), 'jevris'), join('.agents', 'plugins', 'jevris'), join(codexRel(ctx), 'hooks', 'jevris.js')];
    case 'antigravity':
      return [join('.gemini', 'antigravity-cli', 'plugins', 'jevris')];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Uninstall by receipt (one harness), journaled.

function receiptPluginId(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { readonly pluginId?: unknown };
    return typeof parsed.pluginId === 'string' ? parsed.pluginId : null;
  } catch {
    return null;
  }
}

interface RemovalOutcome {
  readonly kept: string[];
  readonly leftover: string[];
  cliSteps: Array<{ file: string; args: string[] }>;
}

/**
 * Jevris 1.x kept its receipts in ~/.jevris on every OS. On macOS that is still the data
 * folder; on Linux (XDG) and Windows (%LOCALAPPDATA%) it is not, so a 1.x home there has its
 * receipts in this legacy folder. Null when it is the data folder or leaves the home.
 */
async function legacyReceiptRoot(pair: HomePair, dataRoot: string): Promise<string | null> {
  const legacy = await boundedPath(pair, relative(pair.resolvedHome, jevrisPaths({ home: pair.resolvedHome }).legacyData));
  return legacy === null || legacy === dataRoot ? null : legacy;
}

async function removeByReceipts(ctx: Ctx, harness: GlobalHarness, hooks: TxnHooks, outcome: RemovalOutcome): Promise<void> {
  const legacyRoot = await legacyReceiptRoot(ctx.pair, ctx.dataRoot);
  const places = RECEIPTS[harness].flatMap((spec) => [ctx.dataRoot, ...(legacyRoot === null ? [] : [legacyRoot])].map((dir) => ({ spec, dir })));
  for (const { spec, dir } of places) {
    const receiptPath = join(dir, spec.name);
    const bytes = await readBytes(receiptPath);
    if (bytes === null) continue;
    if (bytes === 'error') fail(`${spec.name} could not be read; check the permissions of ${dir}`);
    const text = decodeText(bytes);
    if (text === undefined) fail(`${spec.name} is not UTF-8; move it aside and retry`);
    // One receipt file can hold either of two plugin ids (SKL-03); the matching spec reads it.
    const id = receiptPluginId(text);
    if (id !== spec.pluginId && RECEIPTS[harness].some((other) => other.name === spec.name && other.pluginId === id)) continue;
    const receipt = parseReceipt(text, spec.pluginId, ctx.pair);
    if (receipt !== null) {
      const extra = receiptExtra(text);
      const cli = extra.cli;
      if (Array.isArray(cli)) {
        for (const step of cli) {
          if (step !== null && typeof step === 'object' && typeof step.uninstallFile === 'string' && Array.isArray(step.uninstallArgs)) {
            outcome.cliSteps.push({ file: step.uninstallFile, args: step.uninstallArgs.filter((arg: unknown): arg is string => typeof arg === 'string') });
          }
        }
      }
      for (const file of receipt.files) note(ctx, harness, 'delete', file.path, 'Jevris file');
      for (const record of receipt.edits) note(ctx, harness, 'strip', record.file, describeEdit(record));
      if (!ctx.dryRun) {
        const kept: string[] = [];
        if (!(await uninstallV2(ctx.pair, receipt, hooks, outcome.leftover, kept))) {
          fail(`a file listed in ${spec.name} changed while Jevris removed it; retry`);
        }
        for (const path of kept) {
          outcome.kept.push(path);
          note(ctx, harness, 'keep', path, 'changed since install; left in place');
        }
      }
    } else {
      const legacy = legacyOwnedPaths(text, spec.pluginId);
      if (legacy === null) fail(`${spec.name} is not a Jevris receipt Jevris can read; move it aside and retry`);
      await removeLegacyReceipt(ctx, harness, legacy, hooks, outcome);
      if (harness === 'claude') await removeLegacyClaude(ctx, hooks);
    }
    note(ctx, harness, 'delete', receiptPath, 'receipt');
    if (!ctx.dryRun && !(await journaledRemove(receiptPath))) fail(`${spec.name} could not be removed; check permissions`);
  }
}

function describeEdit(record: EditRecord): string {
  if (record.pointer !== undefined) return `remove ${record.pointer}`;
  if (record.table !== undefined) return `remove [${record.table}]`;
  return 'remove the Jevris entry';
}

const LEGACY_SHARED_NAMES: Readonly<Record<string, StripSpec>> = {
  'hooks.json': { kind: 'codex-hooks' },
  'config.toml': { kind: 'toml-table', table: ['mcp_servers', 'jevris'] },
  'kilo.json': { kind: 'json-key', path: ['mcp', 'jevris'] },
  'kilo.jsonc': { kind: 'json-key', path: ['mcp', 'jevris'] },
  'opencode.json': { kind: 'json-key', path: ['mcp', 'jevris'] },
  'opencode.jsonc': { kind: 'json-key', path: ['mcp', 'jevris'] },
  'marketplace.json': { kind: 'json-array-name', path: ['plugins'], name: 'jevris' },
  'mcp_config.json': { kind: 'json-key', path: ['mcpServers', 'jevris'] },
  'settings.json': { kind: 'json-key', path: ['enabledPlugins', LEGACY_CLAUDE_PLUGIN_ID] },
};

async function removeLegacyReceipt(ctx: Ctx, harness: GlobalHarness, owned: readonly string[], hooks: TxnHooks, outcome: RemovalOutcome): Promise<void> {
  // A v1 receipt names absolute paths under the home it was written in; rebase them.
  for (const listed of owned) {
    const path = insideHome(ctx.pair, listed) ? listed : null;
    if (path === null) continue;
    const spec = LEGACY_SHARED_NAMES[basename(path)];
    if (spec !== undefined && basename(path) !== 'package.json') {
      await applyStrip(ctx, { harness, rel: rel(ctx.pair, path), spec, detail: 'Jevris entry from an old install' }, hooks);
      continue;
    }
    await removeLegacyPath(ctx, harness, path, outcome.kept);
  }
}

/** The pre-v2 Claude skills-dir plugin: the folder when it is Jevris's, and the enable key. */
async function removeLegacyClaude(ctx: Ctx, hooks: TxnHooks): Promise<void> {
  const dir = await bounded(ctx.pair, join('.claude', 'skills', 'jevris'));
  if (await exists(dir)) await removeLegacyPath(ctx, 'claude', dir, []);
  await applyStrip(
    ctx,
    { harness: 'claude', rel: join('.claude', 'settings.json'), spec: { kind: 'json-key', path: ['enabledPlugins', LEGACY_CLAUDE_PLUGIN_ID] }, detail: 'old enable key' },
    hooks,
  );
}

async function migrateLegacy(ctx: Ctx, harness: GlobalHarness, hooks: TxnHooks, outcome: RemovalOutcome): Promise<void> {
  for (const strip of legacyStrips(ctx, harness)) await applyStrip(ctx, strip, hooks);
  for (const relPath of legacyUnlisted(ctx, harness)) {
    const abs = await boundedPath(ctx.pair, relPath);
    if (abs !== null && (await exists(abs))) await removeLegacyPath(ctx, harness, abs, outcome.kept);
  }
  if (harness === 'codex') await stripLegacyMarketplace(ctx, hooks);
}

/** v1.1 wrote a marketplace entry `./jevris` relative to ~/.agents/plugins; drop it when stale. */
async function stripLegacyMarketplace(ctx: Ctx, hooks: TxnHooks): Promise<void> {
  const abs = await bounded(ctx.pair, join('.agents', 'plugins', 'marketplace.json'));
  const text = await readText(abs);
  if (text === null) return;
  const root = parseJsoncTree(text);
  if (root === null) return;
  const plugins = findNode(root, ['plugins']);
  const value = plugins === undefined ? undefined : nodeValue(plugins);
  if (!Array.isArray(value)) return;
  const stale = value.some((item) => item !== null && typeof item === 'object' && (item as { name?: unknown }).name === 'jevris' && JSON.stringify(item).includes('"./jevris"'));
  if (!stale) return;
  await applyStrip(ctx, { harness: 'codex', rel: rel(ctx.pair, abs), spec: { kind: 'json-array-name', path: ['plugins'], name: 'jevris' }, detail: 'old marketplace entry ./jevris' }, hooks);
}

// ---------------------------------------------------------------------------
// Operation driver.

async function resolveDataRoot(pair: HomePair): Promise<string> {
  const dataRoot = await boundedPath(pair, dataRel(pair));
  if (dataRoot === null) fail('the Jevris data directory resolves outside the home; fix the symlink and retry');
  return dataRoot;
}

function report(partial: Partial<OperationReport> & Pick<OperationReport, 'ok' | 'status'>): OperationReport {
  const changes = partial.changes ?? [];
  return {
    ok: partial.ok,
    status: partial.status,
    installStatus: partial.ok ? 'reduced' : 'refused',
    changedPaths: partial.changedPaths ?? [],
    changes,
    runtime: partial.runtime ?? null,
    smoke: partial.smoke ?? [],
    nextSteps: partial.nextSteps ?? [],
    error: partial.error ?? null,
    conflicts: partial.conflicts ?? [],
    backup: partial.backup ?? null,
  };
}

function refusedReport(error: string, extra: Partial<OperationReport> = {}): OperationReport {
  return report({ ...extra, ok: false, status: extra.status ?? 'refused', error });
}

/** Harnesses with a current receipt under this data root. */
export async function installedHarnesses(dataRoot: string, legacyRoot: string | null = null): Promise<GlobalHarness[]> {
  const out: GlobalHarness[] = [];
  const dirs = legacyRoot === null ? [dataRoot] : [dataRoot, legacyRoot];
  for (const harness of GLOBAL_HARNESSES) {
    for (const spec of RECEIPTS[harness].flatMap((item) => dirs.map((dir) => join(dir, item.name)))) {
      if ((await readBytes(spec)) !== null) {
        out.push(harness);
        break;
      }
    }
  }
  return out;
}

/** Runtime versions any current receipt points at. */
async function referencedRuntimes(dataRoot: string): Promise<Set<string>> {
  const keep = new Set<string>();
  for (const harness of GLOBAL_HARNESSES) {
    const spec = RECEIPTS[harness][0];
    if (spec === undefined) continue;
    const text = await readText(join(dataRoot, spec.name));
    if (text === null) continue;
    const version = receiptExtra(text).runtimeVersion;
    if (typeof version === 'string') keep.add(version);
  }
  return keep;
}

/** The runtime copy a harness's current receipt points at, or null when none is recorded. */
export async function installedRuntime(dataRoot: string, harness: GlobalHarness): Promise<{ readonly dir: string; readonly version: string } | null> {
  const spec = RECEIPTS[harness][0];
  if (spec === undefined) return null;
  const text = await readText(join(dataRoot, spec.name));
  if (text === null) return null;
  const version = receiptExtra(text).runtimeVersion;
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) return null;
  return { dir: join(dataRoot, 'runtime', version), version };
}

/**
 * Whether a certification record covers a feature of a harness at its installed version: its
 * observe hooks by default (Antigravity's hook group), or a named feature (Claude's gated events).
 * The certification module decides.
 */
export type HookCertification = (harness: GlobalHarness, featureId?: CertificationFeature) => Promise<boolean>;

/** The gated Claude events whose feature a record certifies. */
export async function certifiedClaudeGates(certified: HookCertification): Promise<string[]> {
  const out: string[] = [];
  for (const [event, featureId] of Object.entries(CLAUDE_GATED_HOOKS)) if (await certified('claude', featureId)) out.push(event);
  return out;
}

/**
 * The gated Claude events the installed plugin's hooks.json registers (B's LOW 31 on access limits
 * R68). Only the event names are read. Null when no installed plugin hooks.json can be read.
 */
export async function renderedClaudeGates(home: string): Promise<string[] | null> {
  const text = await readText(join(home, CLAUDE_MARKETPLACE_REL, 'plugins', 'jevris', 'hooks', 'hooks.json'));
  if (text === null) return null;
  let hooks: unknown;
  try {
    hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
  } catch {
    return null;
  }
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return null;
  const registered = hooks as object;
  return Object.keys(CLAUDE_GATED_HOOKS).filter((event) => Object.hasOwn(registered, event));
}

/**
 * Doctor's line for Claude's gated events, from the installed hooks.json and the features the
 * record for the installed binary certifies (B's LOW 31). A registered event whose feature is no
 * longer certified there (a new binary, a demotion) is an action: `jevris install` renders the
 * plugin again without it. A certified event not registered yet (certified outside install) is
 * information: the feature is optional. Null when both agree, or nothing can be compared.
 */
export function claudeGateLine(rendered: readonly string[] | null, certifiedFeatures: readonly string[], version: string | null): string | null {
  if (rendered === null || version === null) return null;
  const gates = Object.entries(CLAUDE_GATED_HOOKS);
  const fix = `jevris install --harness ${LAUNCHER.claude}`;
  const stale = gates.filter(([event, featureId]) => rendered.includes(event) && !certifiedFeatures.includes(featureId));
  if (stale.length > 0) return `harness claude install: ${stale.map(([event]) => event).join(', ')} registered, but ${stale.map(([, featureId]) => featureId).join(', ')} is not certified for ${version}; fix: ${fix}`;
  const missing = gates.filter(([event, featureId]) => !rendered.includes(event) && certifiedFeatures.includes(featureId));
  if (missing.length > 0) return `harness claude hooks: ${missing.map(([event]) => event).join(', ')} not registered yet, although ${missing.map(([, featureId]) => featureId).join(', ')} is certified for ${version}; to add: ${fix}`;
  return null;
}

async function installOne(ctx: Ctx, harness: GlobalHarness, hooks: TxnHooks, certified: HookCertification): Promise<{ changed: string[]; cli: unknown[] }> {
  const outcome: RemovalOutcome = { kept: [], leftover: [], cliSteps: [] };
  await removeByReceipts(ctx, harness, hooks, outcome);
  await migrateLegacy(ctx, harness, hooks, outcome);
  if (!ctx.dryRun) await runCliSteps(ctx, outcome.cliSteps);
  const txn = new InstallTxn(ctx.pair, hooks, ctx.dryRun);
  const cli: unknown[] = [];
  let marketplace: string | null = null;
  switch (harness) {
    case 'claude':
      await planClaude(txn, ctx, await certifiedClaudeGates(certified));
      break;
    case 'kilocode':
    case 'opencode':
      await planShimHarness(txn, ctx, harness);
      break;
    case 'codex':
      marketplace = (await planCodex(txn, ctx)).marketplace;
      break;
    case 'antigravity':
      await planAntigravity(txn, ctx, await certified('antigravity'));
      break;
  }
  if (ctx.dryRun) return { changed: [], cli };
  if (!(await txn.commitEdits())) fail(`a ${harness} config file changed while Jevris wrote it; retry`);
  const pluginId = RECEIPTS[harness][0]?.pluginId ?? `jevris@${harness}`;
  const receiptPath = join(ctx.dataRoot, RECEIPTS[harness][0]?.name ?? `${harness}-install-receipt.json`);
  if (harness === 'claude') cli.push(...(await claudeCli(ctx)));
  if (harness === 'codex' && marketplace !== null) cli.push(...(await codexCli(ctx, marketplace)));
  if (harness === 'antigravity') cli.push(...(await antigravityCli(ctx)));
  if (!(await txn.writeReceipt(receiptPath, pluginId, { runtimeVersion: ctx.manifest.version, harness, cli }))) {
    fail(`the ${harness} receipt could not be written under ${ctx.dataRoot}; check permissions`);
  }
  const receipt = txn.receipt(pluginId);
  for (const file of receipt.files) note(ctx, harness, 'create', file.path, 'Jevris file');
  return { changed: [...receipt.files.map((file) => file.path), ...receipt.edits.map((record) => record.file), receiptPath], cli };
}

async function runCliSteps(ctx: Ctx, steps: ReadonlyArray<{ file: string; args: string[] }>): Promise<void> {
  for (const step of steps) {
    if (!ctx.cli.available(step.file)) continue;
    await harnessRun(ctx, step.file, step.args);
  }
}

/** harnessHome only when it is the OS account's own home (macOS certify); otherwise null. */
function accountHarnessHome(candidate: string | undefined): string | null {
  if (candidate === undefined) return null;
  const account = accountHome();
  return account !== null && resolve(candidate) === resolve(account) ? account : null;
}

/**
 * The environment a harness CLI runs with: HOME (and USERPROFILE) is the home being
 * installed, so `--home` never changes another profile. macOS certify alone runs Claude Code
 * with the account's HOME and its config folder inside the install home.
 */
function harnessEnv(ctx: Ctx): { readonly [key: string]: string | undefined } {
  const home = ctx.harnessHome ?? ctx.pair.resolvedHome;
  const env: { [key: string]: string | undefined } = { ...ctx.env, HOME: home, USERPROFILE: home };
  // A Claude config folder outside this home would send Claude's plugin commands to another profile.
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  if (typeof claudeDir === 'string' && !insideHome(ctx.pair, claudeDir)) delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/**
 * Runs a harness CLI. Claude Code rewrites ~/.claude/settings.json on plugin commands; when
 * the rewrite only reformats (same JSON value), the user's bytes are put back.
 */
async function harnessRun(ctx: Ctx, file: string, args: readonly string[]): Promise<{ readonly spawned: boolean; readonly code: number; readonly stdout: string }> {
  const settings = file === 'claude' ? await boundedPath(ctx.pair, join('.claude', 'settings.json')) : null;
  const before = settings === null ? null : await readBytes(settings);
  const ran = await ctx.cli.run(file, args, 60000, harnessEnv(ctx));
  if (settings !== null && before !== null && before !== 'error') await keepSettingsBytes(settings, before);
  return ran;
}

function sameJson(left: string, right: string): boolean {
  const a = parseJsoncTree(left);
  const b = parseJsoncTree(right);
  if (a === null || b === null) return false;
  return canonicalJson(nodeValue(a)) === canonicalJson(nodeValue(b));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function keepSettingsBytes(path: string, before: Uint8Array): Promise<void> {
  const after = await readBytes(path);
  if (after === null || after === 'error') return;
  if (sha256(after) === sha256(before)) return;
  const beforeText = decodeText(before);
  const afterText = decodeText(after);
  if (beforeText === undefined || afterText === undefined || !sameJson(beforeText, afterText)) return;
  await casWrite(path, sha256(after), beforeText);
}

async function claudeCli(ctx: Ctx): Promise<unknown[]> {
  const market = join(ctx.pair.resolvedHome, CLAUDE_MARKETPLACE_REL);
  const steps = [`claude plugin marketplace add ~/${forwardSlashes(CLAUDE_MARKETPLACE_REL)}`, `claude plugin install ${CLAUDE_PLUGIN_ID}`];
  if (!ctx.cli.available('claude')) {
    ctx.nextSteps.push(`Claude Code: if /plugin does not list ${CLAUDE_PLUGIN_ID} after a restart, run \`${steps[0]}\` and \`${steps[1]}\`.`);
    return [];
  }
  const added = await harnessRun(ctx, 'claude', ['plugin', 'marketplace', 'add', market]);
  note(ctx, 'claude', 'run', market, `claude plugin marketplace add (exit ${added.code})`);
  const installed = added.spawned && added.code === 0 ? await harnessRun(ctx, 'claude', ['plugin', 'install', CLAUDE_PLUGIN_ID]) : null;
  if (installed !== null) note(ctx, 'claude', 'run', market, `claude plugin install ${CLAUDE_PLUGIN_ID} (exit ${installed.code})`);
  if (installed === null || !installed.spawned || installed.code !== 0) {
    ctx.nextSteps.push(`Claude Code: \`${steps[0]}\` and \`${steps[1]}\` did not complete; run them yourself.`);
    return added.spawned && added.code === 0 ? [{ harness: 'claude', uninstallFile: 'claude', uninstallArgs: ['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE] }] : [];
  }
  ctx.nextSteps.push('Claude Code: restart Claude Code; /plugin lists jevris and /hooks shows the Jevris hooks.');
  return [
    { harness: 'claude', uninstallFile: 'claude', uninstallArgs: ['plugin', 'uninstall', CLAUDE_PLUGIN_ID] },
    { harness: 'claude', uninstallFile: 'claude', uninstallArgs: ['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE] },
  ];
}

async function codexCli(ctx: Ctx, marketplace: string): Promise<unknown[]> {
  const id = `jevris@${marketplace}`;
  const steps = [`codex plugin add ${id}`, 'then start codex and run /hooks to review and trust the Jevris hooks'];
  if (!ctx.cli.available('codex')) {
    ctx.nextSteps.push(`Codex: run \`${steps[0]}\` (installs the plugin into the Codex cache), ${steps[1]}.`);
    return [];
  }
  const added = await harnessRun(ctx, 'codex', ['plugin', 'add', id]);
  note(ctx, 'codex', 'run', join(ctx.pair.resolvedHome, codexRel(ctx)), `codex plugin add ${id} (exit ${added.code})`);
  if (!added.spawned || added.code !== 0) {
    ctx.nextSteps.push(`Codex: \`${steps[0]}\` did not complete; run it yourself, ${steps[1]}.`);
    return [];
  }
  ctx.nextSteps.push('Codex: start codex and run /hooks to review and trust the Jevris hooks.');
  return [{ harness: 'codex', uninstallFile: 'codex', uninstallArgs: ['plugin', 'remove', id] }];
}

/**
 * AGY-01: register the plugin with the Antigravity CLI. `agy plugin install <dir>` copies <dir>
 * into ~/.gemini/config/plugins/<name> and records it in ~/.gemini/config/import_manifest.json
 * (agy 1.2.11); it refuses a source that is already that folder. So agy installs from a private
 * staging copy of the plugin Jevris just wrote, which it copies back byte for byte, and the copy
 * is removed afterwards. The Antigravity app and IDE read the same folder.
 */
async function antigravityCli(ctx: Ctx): Promise<unknown[]> {
  const plugin = join(ctx.pair.resolvedHome, '.gemini', 'config', 'plugins', 'jevris');
  if (!ctx.cli.available('agy')) {
    ctx.nextSteps.push('Antigravity: the plugin is in ~/.gemini/config/plugins/jevris, where the Antigravity app and IDE load it. The Antigravity CLI (agy) was not found; after installing it, run jevris install --harness antigravity again to register the plugin with it.');
    return [];
  }
  const staging = join(ctx.dataRoot, 'staging', 'antigravity', 'jevris');
  let installed: { readonly spawned: boolean; readonly code: number } = { spawned: false, code: -1 };
  try {
    await rm(staging, { recursive: true, force: true });
    await cp(plugin, staging, { recursive: true, dereference: false });
    installed = await harnessRun(ctx, 'agy', ['plugin', 'install', staging]);
  } catch {
    installed = { spawned: false, code: -1 };
  } finally {
    await rm(join(ctx.dataRoot, 'staging'), { recursive: true, force: true });
  }
  note(ctx, 'antigravity', 'run', plugin, `agy plugin install (exit ${installed.code})`);
  if (!installed.spawned || installed.code !== 0) {
    ctx.nextSteps.push('Antigravity: `agy plugin install` did not complete, so the agy CLI does not list the plugin yet; run jevris install --harness antigravity again.');
    return [];
  }
  return [{ harness: 'antigravity', uninstallFile: 'agy', uninstallArgs: ['plugin', 'uninstall', 'jevris'] }];
}

async function noCertification(): Promise<boolean> {
  return false;
}

/**
 * Installs (or upgrades) one harness or all five. Dry run lists every planned change and
 * writes nothing. Returns a report; `ok: false` always means every file is as it was, or
 * lists the conflicts it could not restore.
 */
export async function installGlobal(input: InstallOptions, certified: HookCertification = noCertification): Promise<OperationReport> {
  const pair = await homePair(input.home);
  if (pair === null) return refusedReport(`the home ${input.home} does not exist; pass --home with an existing directory`);
  const selected = input.harness === undefined ? [...GLOBAL_HARNESSES] : [input.harness];
  const hooks: TxnHooks = input.afterConfigRead === undefined ? {} : { afterConfigRead: input.afterConfigRead };
  const dryRun = input.dryRun === true;
  const manifest = await readRuntimeManifest(input.root);
  if (manifest === null) return refusedReport(`no runtime manifest in ${input.root}; reinstall @webventures/jevris or run npm run build`);
  let dataRoot: string;
  try {
    dataRoot = await resolveDataRoot(pair);
  } catch (error) {
    return refusedReport(error instanceof PlanError ? error.message : 'the data directory could not be resolved');
  }
  const ctx: Ctx = {
    pair,
    dataRoot,
    runtimeDir: runtimeDir(dataRoot, manifest.version),
    readRoot: dryRun ? input.root : runtimeDir(dataRoot, manifest.version),
    manifest,
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
    cli: input.cli ?? defaultHarnessCli,
    harnessHome: accountHarnessHome(input.harnessHome),
    dryRun,
    changes: [],
    nextSteps: [],
  };
  const plan = await planRuntime(input.root, manifest);
  if ('error' in plan) return refusedReport(plan.error);
  note(ctx, 'runtime', 'copy', ctx.runtimeDir, `${manifest.name} ${manifest.version} (${plan.files.length} files)`);
  // The `jevris` command (command-launcher.ts): written for the real platform only.
  const place: CommandPlace = { home: pair.resolvedHome, dataRoot, platform: ctx.platform, env: ctx.env };
  const commandEntry = ctx.platform === process.platform ? runtimeEntry(ctx.runtimeDir, manifest, 'bin') : null;
  if (commandEntry !== null) {
    const launcher = await planLauncher(place);
    note(ctx, 'runtime', launcher.action, launcher.path, launcher.action === 'keep' ? launcher.reason : 'jevris command');
  }
  if (dryRun) {
    try {
      for (const harness of selected) await installOne(ctx, harness, hooks, certified);
    } catch (error) {
      return refusedReport(error instanceof PlanError ? error.message : 'the plan could not be made', { changes: ctx.changes });
    }
    return report({ ok: true, status: 'planned', changes: ctx.changes, runtime: { dir: ctx.runtimeDir, version: manifest.version }, nextSteps: ctx.nextSteps });
  }
  const journal = new InstallJournal(pair, join(dataRoot, 'backups', backupSetName()), 'install');
  const copied = await copyRuntime(dataRoot, plan);
  if (!copied.ok) return refusedReport(copied.error);
  const runtimeCopy: RuntimeCopy = copied.copy;
  setActiveJournal(journal);
  const changed: string[] = [];
  let smoke: SmokeResult[] = [];
  try {
    for (const harness of selected) changed.push(...(await installOne(ctx, harness, hooks, certified)).changed);
    if (input.smoke !== false) {
      smoke = await runInstallSmoke({ runtimeDir: ctx.runtimeDir, manifest, harnesses: selected, home: pair.resolvedHome });
      const failed = smoke.find((result) => !result.ok);
      if (failed !== undefined) fail(`post-install smoke failed for ${failed.harness} (${failed.check}: ${failed.detail}); nothing was left changed`);
    }
  } catch (error) {
    setActiveJournal(null);
    const restored = await journal.restore();
    await rollbackRuntime(runtimeCopy);
    return refusedReport(error instanceof PlanError ? error.message : `install failed (${String(error).slice(0, 200)}); nothing was left changed`, {
      status: 'restored',
      changes: ctx.changes,
      smoke,
      conflicts: restored.conflicts.map((path) => rel(pair, path)),
      backup: journal.dir,
    });
  }
  setActiveJournal(null);
  await commitRuntime(dataRoot, runtimeCopy);
  const keep = await referencedRuntimes(dataRoot);
  keep.add(manifest.version);
  await pruneRuntimes(dataRoot, keep);
  await journal.finish();
  await pruneBackups(dataRoot);
  await refreshHarnessVersions(pair.resolvedHome, selected, ctx.cli, harnessEnv(ctx));
  // B's private-file rule: an older Jevris left receipts 0644 and ~/.jevris 0755. Install
  // tightens every Jevris entry this user owns (never on a simulated platform).
  if ((input.platform ?? process.platform) === process.platform) await walkPrivate({ home: pair.resolvedHome, repair: true });
  if (commandEntry !== null) {
    // A new runtime re-points the launcher; a `jevris` that is not Jevris's own stays as it is.
    const written = await writeLauncher(place, input.node ?? process.execPath, commandEntry);
    note(ctx, 'runtime', written.ok ? written.action : 'keep', written.path, written.ok ? 'jevris command' : written.reason);
    if (!written.ok) ctx.nextSteps.push(`The jevris command was not written: ${written.reason}. Run Jevris as: node ${shellQuote(commandEntry)}`);
  }
  return report({
    ok: true,
    status: 'installed',
    changedPaths: changed,
    changes: ctx.changes,
    runtime: { dir: ctx.runtimeDir, version: manifest.version },
    smoke,
    nextSteps: ctx.nextSteps,
    backup: journal.touched.length > 0 ? journal.dir : null,
  });
}

export interface UninstallOptions {
  readonly home: string;
  readonly harness?: GlobalHarness;
  readonly dryRun?: boolean;
  readonly deleteData?: boolean;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly cli?: HarnessCli;
  readonly afterConfigRead?: (path: string) => void | Promise<void>;
  readonly afterSettingsRead?: () => void | Promise<void>;
  /** Tests only: stands in for launchctl, systemctl or schtasks when the service unit is removed. */
  readonly serviceExec?: ServiceExec;
  /** Tests only: stands in for reg.exe when the Windows user PATH entry is removed. */
  readonly regExec?: RegExec;
}

export type ServiceExec = (file: string, args: readonly string[]) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };

async function sameDir(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

export interface SidecarStopOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** Whether the per-user service unit was asked to be removed. */
  readonly serviceRemoval: boolean;
  /** A next step when a service unit may still exist for this home. */
  readonly nextStep: string | null;
}

/**
 * IPC-17: before uninstall or data delete removes anything, this home's sidecar is stopped (B's
 * stopSidecarForRemoval). The per-user service unit (IPC-20) is one per OS account, not one per
 * Jevris home, so it is removed only when asked and the home is the account's own home. For any
 * other home (a --home or JEVRIS_HOME elsewhere), the unit may serve the account's real home and
 * is left alone; the next step names `jevris service uninstall` instead.
 */
export async function stopSidecarBeforeRemoval(home: string, removeService: boolean, serviceExec?: ServiceExec): Promise<SidecarStopOutcome> {
  const ownHome = removeService && (await sameDir(home, resolveHome({ env: {} }).home));
  try {
    const { stopSidecarForRemoval } = await import('./runtime-commands.js');
    const stopped = await stopSidecarForRemoval(home, { removeService: ownHome, ...(serviceExec === undefined ? {} : { serviceExec }) });
    const nextStep = removeService && !ownHome ? `If you ran jevris service install for ${home}, also run jevris service uninstall --home ${shellQuote(home)}.` : null;
    return { ok: stopped.stopped, message: stopped.message, serviceRemoval: ownHome, nextStep };
  } catch {
    return { ok: false, message: 'The Jevris sidecar could not be checked. Run `jevris sidecar stop`, then retry.', serviceRemoval: false, nextStep: null };
  }
}

/** Removes one harness or all five by receipt, migrates legacy leftovers, and removes the runtime when nothing uses it. */
export async function uninstallGlobal(input: UninstallOptions): Promise<OperationReport> {
  const pair = await homePair(input.home);
  if (pair === null) return refusedReport(`the home ${input.home} does not exist; pass --home with an existing directory`);
  const selected = input.harness === undefined ? [...GLOBAL_HARNESSES] : [input.harness];
  const hooks: TxnHooks = input.afterConfigRead === undefined ? {} : { afterConfigRead: input.afterConfigRead };
  let dataRoot: string;
  try {
    dataRoot = await resolveDataRoot(pair);
  } catch (error) {
    return refusedReport(error instanceof PlanError ? error.message : 'the data directory could not be resolved');
  }
  const ctx: Ctx = {
    pair,
    dataRoot,
    runtimeDir: join(dataRoot, 'runtime'),
    readRoot: join(dataRoot, 'runtime'),
    manifest: { schemaVersion: 1, name: 'jevris', version: '0.0.0', engines: {}, entries: {}, files: [], runtimeDependencies: {}, optionalDependencies: {} },
    platform: process.platform,
    env: input.env ?? process.env,
    cli: input.cli ?? defaultHarnessCli,
    harnessHome: null,
    dryRun: input.dryRun === true,
    changes: [],
    nextSteps: [],
  };
  if (!ctx.dryRun) {
    // IPC-17: nothing is removed while this home's sidecar runs. The service unit goes too when
    // this uninstall removes the last harness or the data.
    const before = await installedHarnesses(dataRoot);
    const last = before.every((harness) => selected.includes(harness));
    const stopped = await stopSidecarBeforeRemoval(input.home, last || input.deleteData === true, input.serviceExec);
    if (!stopped.ok) return refusedReport(`nothing was removed: ${stopped.message}`);
    if (stopped.nextStep !== null) ctx.nextSteps.push(stopped.nextStep);
  }
  const journal = new InstallJournal(pair, join(dataRoot, 'backups', backupSetName()), 'uninstall');
  const outcome: RemovalOutcome = { kept: [], leftover: [], cliSteps: [] };
  if (!ctx.dryRun) setActiveJournal(journal);
  try {
    for (const harness of selected) {
      await removeByReceipts(ctx, harness, hooks, outcome);
      await migrateLegacy(ctx, harness, hooks, outcome);
    }
  } catch (error) {
    setActiveJournal(null);
    const restored = ctx.dryRun ? { conflicts: [] as string[] } : await journal.restore();
    return refusedReport(error instanceof PlanError ? error.message : 'uninstall failed; nothing was left changed', {
      status: ctx.dryRun ? 'refused' : 'restored',
      changes: ctx.changes,
      conflicts: restored.conflicts.map((path) => rel(pair, path)),
    });
  }
  setActiveJournal(null);
  // The last one out removes the `jevris` command, its PATH block and its user PATH entry.
  const place: CommandPlace = { home: pair.resolvedHome, dataRoot, platform: ctx.platform, env: ctx.env };
  const access = { accountHome: await sameDir(input.home, resolveHome({ env: {} }).home), ...(input.regExec === undefined ? {} : { regExec: input.regExec }) };
  if (ctx.dryRun) {
    const before = await installedHarnesses(dataRoot);
    if (input.deleteData === true || before.every((harness) => selected.includes(harness))) {
      const planned = await removeCommand(place, { ...access, dryRun: true });
      for (const step of planned.steps) note(ctx, 'runtime', step.action, step.path, step.detail);
    }
    return report({ ok: true, status: 'planned', changes: ctx.changes });
  }
  await runCliSteps(ctx, outcome.cliSteps);
  await settleLeftoverDirs(pair, dataRoot, outcome.leftover);
  const remaining = await installedHarnesses(dataRoot);
  const keep = await referencedRuntimes(dataRoot);
  if (remaining.length === 0) keep.clear();
  await pruneRuntimes(dataRoot, keep);
  if (remaining.length === 0 || input.deleteData === true) {
    const removed = await removeCommand(place, access);
    for (const step of removed.steps) note(ctx, 'runtime', step.action, step.path, step.detail);
    ctx.nextSteps.push(...removed.nextSteps);
  } else {
    await repointLauncher(place);
  }
  await journal.finish();
  await pruneBackups(dataRoot);
  if (input.deleteData === true) {
    const { purgeKillSwitchData } = await import('./kill-switch.js');
    const purged = await purgeKillSwitchData(input.home);
    if (!purged.ok) return refusedReport(`Jevris was removed from the harnesses but its data was kept: ${purged.message}`, { changes: ctx.changes });
    const deleted = await deleteJevrisData({ home: input.home });
    if (!deleted.ok) return refusedReport(`Jevris was removed from the harnesses but ${dataRoot} could not be deleted; remove it by hand`, { changes: ctx.changes });
    note(ctx, 'runtime', 'delete', dataRoot, 'Jevris data');
  }
  if (outcome.kept.length > 0) {
    ctx.nextSteps.push(`${outcome.kept.length} file(s) changed after install were left in place; review them and delete what you do not need.`);
  }
  return report({ ok: true, status: 'removed', changes: ctx.changes, nextSteps: ctx.nextSteps, conflicts: outcome.kept.map((path) => rel(pair, path)) });
}

/** Removes a harness install by its receipts (compatibility helper for tests and doctor). */
export async function uninstallHarness(home: string, harness: GlobalHarness, hooks: TxnHooks = {}): Promise<boolean> {
  const result = await uninstallGlobal({ home, harness, ...(hooks.afterConfigRead === undefined ? {} : { afterConfigRead: hooks.afterConfigRead }) });
  return result.ok;
}

/** Deletes a stale staging directory a crashed install left under the data root. */
export async function clearStaging(dataRoot: string): Promise<void> {
  await pruneRuntimes(dataRoot, new Set(), true);
  try {
    await rm(join(dataRoot, 'runtime', '.lock'), { force: true });
  } catch {
    // Nothing to clear.
  }
}

