/**
 * The `jevris` command (owner report 2026-09-26: "Once I've installed jevris from the GitHub
 * repo, I have no Jevris executable on my path").
 *
 * Install writes a small launcher that always runs the installed runtime copy
 * (`<data>/runtime/<version>/bin/jevris.mjs`) with the Node.js that ran install:
 *
 * - macOS and Linux: `~/.local/bin/jevris`, a POSIX sh script, mode 0755. The paths are single
 *   quoted and arguments pass through as `"$@"`, so the shell never interprets user input.
 * - Windows: `%LOCALAPPDATA%\Jevris\bin\jevris.cmd`. PowerShell finds it through PATHEXT. No
 *   `jevris.ps1` is written: PowerShell prefers a .ps1 over a .cmd in the same folder, and a
 *   Restricted execution policy would then block the command.
 *
 * Each launcher carries a marker line; install never overwrites and uninstall never removes a
 * `jevris` without it. A new runtime re-points the launcher. What install did (the launcher,
 * the PATH block in a shell profile, the Windows user PATH entry) is recorded in
 * `<data>/jevris-command-receipt.json`, and the last uninstall removes each of them when the
 * receipt or a marker proves it is Jevris's own.
 *
 * PATH is never edited silently: an interactive install asks once; otherwise, and on a no,
 * install prints the exact line to add. A `jevris` already on PATH that is not this launcher
 * (for example a global npm install) is left alone, and install says which one runs.
 */
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { envValue, pathApiFor, resolveExecutable, writePrivateFile, type EnvLike } from '@jevris/platform';
import { runCaptured } from './live-harness.js';
import { readRuntimeManifest, runtimeEntry, runtimeRoot } from './runtime-install.js';

export const LAUNCHER_MARKER = 'jevris-launcher: written by jevris install; jevris uninstall removes it';
export const COMMAND_RECEIPT = 'jevris-command-receipt.json';
export const BLOCK_BEGIN = '# >>> jevris PATH >>>';
export const BLOCK_END = '# <<< jevris PATH <<<';
const BLOCK_NOTE = '# Added by jevris install; jevris uninstall removes this block.';
const REINSTALL = 'npx @cryptventure/jevris install --yes';
const READ_CAP = 65536;

/** Stands in for `reg.exe` (tests inject it; the real one runs only on Windows for the account's own home). */
export type RegExec = (args: readonly string[]) => Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>;

export interface CommandReceipt {
  readonly schemaVersion: 1;
  readonly launcher: { readonly path: string; readonly node: string; readonly entry: string; readonly dirCreated: boolean };
  /** The shell profile install added the marked PATH block to, and whether install created that file. */
  readonly profile: { readonly file: string; readonly created: boolean } | null;
  /** The folder install added to the Windows user PATH (HKCU\Environment). */
  readonly windowsPath: { readonly dir: string } | null;
  /** The PATH question is asked once; a no is remembered. */
  readonly pathOffer: 'accepted' | 'declined' | null;
  /** Folders install created (for the launcher or a fish conf.d file); uninstall removes each one left empty. */
  readonly createdDirs: readonly string[];
}

export interface CommandPlace {
  /** The Jevris home (the resolved one). */
  readonly home: string;
  /** The Jevris data folder for that home. */
  readonly dataRoot: string;
  readonly platform: string;
  readonly env: EnvLike;
}

interface PathApi {
  readonly delimiter: string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

function api(platform: string): PathApi {
  return pathApiFor(platform) as unknown as PathApi;
}

const posix = api('linux');
const win32 = api('win32');

export function launcherDir(place: CommandPlace): string {
  const path = api(place.platform);
  return place.platform === 'win32' ? path.join(place.dataRoot, 'bin') : path.join(place.home, '.local', 'bin');
}

export function launcherPath(place: CommandPlace): string {
  return api(place.platform).join(launcherDir(place), place.platform === 'win32' ? 'jevris.cmd' : 'jevris');
}

export function commandReceiptPath(place: CommandPlace): string {
  return api(place.platform).join(place.dataRoot, COMMAND_RECEIPT);
}

/** `~/…` for a path under the home, else the path. */
export function shown(place: CommandPlace, abs: string): string {
  const path = api(place.platform);
  const back = path.relative(place.home, abs);
  if (back.length === 0 || back.startsWith('..') || path.isAbsolute(back)) return abs;
  return place.platform === 'win32' ? abs : `~/${back}`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdValue(value: string): string {
  // Inside `set "NAME=value"` only % needs doubling; Windows paths cannot contain a quote.
  return value.replace(/%/g, '%%');
}

/** The launcher text for this platform. */
export function launcherScript(platform: string, node: string, entry: string): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      `rem ${LAUNCHER_MARKER}`,
      'setlocal',
      `set "JEVRIS_NODE=${cmdValue(node)}"`,
      `set "JEVRIS_ENTRY=${cmdValue(entry)}"`,
      'if not exist "%JEVRIS_NODE%" goto nonode',
      'if not exist "%JEVRIS_ENTRY%" goto noentry',
      '"%JEVRIS_NODE%" "%JEVRIS_ENTRY%" %*',
      'exit /b %ERRORLEVEL%',
      ':nonode',
      `>&2 echo jevris: the Node.js that installed Jevris is gone: "%JEVRIS_NODE%". Install Node.js again, then run: ${REINSTALL}`,
      'exit /b 127',
      ':noentry',
      `>&2 echo jevris: the Jevris runtime is gone: "%JEVRIS_ENTRY%". Reinstall with: ${REINSTALL}`,
      'exit /b 127',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `# ${LAUNCHER_MARKER}`,
    `node=${shQuote(node)}`,
    `entry=${shQuote(entry)}`,
    'if [ ! -x "$node" ]; then',
    `  echo "jevris: the Node.js that installed Jevris is gone: $node. Install Node.js again, then run: ${REINSTALL}" >&2`,
    '  exit 127',
    'fi',
    'if [ ! -f "$entry" ]; then',
    `  echo "jevris: the Jevris runtime is gone: $entry. Reinstall with: ${REINSTALL}" >&2`,
    '  exit 127',
    'fi',
    'exec "$node" "$entry" "$@"',
    '',
  ].join('\n');
}

async function readCapped(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > READ_CAP) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** ours: a regular file with the marker line; foreign: anything else at that path; missing. */
export async function launcherState(path: string): Promise<'ours' | 'foreign' | 'missing'> {
  if (!(await exists(path))) return 'missing';
  const text = await readCapped(path);
  if (text === null) return 'foreign';
  return text.split(/\r?\n/).slice(0, 3).some((line) => line.includes(LAUNCHER_MARKER)) ? 'ours' : 'foreign';
}

export async function readCommandReceipt(place: CommandPlace): Promise<CommandReceipt | null> {
  const text = await readCapped(commandReceiptPath(place));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<CommandReceipt>;
    const launcher = value.launcher;
    if (value.schemaVersion !== 1 || launcher === undefined || typeof launcher.path !== 'string' || typeof launcher.node !== 'string' || typeof launcher.entry !== 'string') return null;
    const profile = value.profile;
    const windowsPath = value.windowsPath;
    return {
      schemaVersion: 1,
      launcher: { path: launcher.path, node: launcher.node, entry: launcher.entry, dirCreated: launcher.dirCreated === true },
      profile: profile !== null && typeof profile === 'object' && typeof profile.file === 'string' ? { file: profile.file, created: profile.created === true } : null,
      windowsPath: windowsPath !== null && typeof windowsPath === 'object' && typeof windowsPath.dir === 'string' ? { dir: windowsPath.dir } : null,
      pathOffer: value.pathOffer === 'accepted' || value.pathOffer === 'declined' ? value.pathOffer : null,
      createdDirs: Array.isArray(value.createdDirs) ? value.createdDirs.filter((item): item is string => typeof item === 'string') : [],
    };
  } catch {
    return null;
  }
}

async function writeCommandReceipt(place: CommandPlace, receipt: CommandReceipt): Promise<void> {
  await writePrivateFile(commandReceiptPath(place), `${JSON.stringify(receipt, null, 2)}\n`);
}

/** Creates `dir` and its missing parents; returns the folders it created, outermost first. */
async function makeDirs(dir: string, platform: string): Promise<string[]> {
  const missing: string[] = [];
  let current = dir;
  while (!(await exists(current))) {
    missing.unshift(current);
    const parent = api(platform).dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (missing.length > 0) await mkdir(dir, { recursive: true, mode: 0o755 });
  return missing;
}

function mergeDirs(previous: readonly string[], added: readonly string[]): string[] {
  return [...new Set([...previous, ...added])];
}

/** Writes a file through a temporary sibling and a rename, with `mode`. */
async function replaceFile(path: string, text: string, mode: number): Promise<void> {
  const temp = `${path}.jevris-${String(process.pid)}.tmp`;
  try {
    await writeFile(temp, text, { mode });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export type LauncherPlan =
  | { readonly action: 'create' | 'replace'; readonly path: string }
  | { readonly action: 'keep'; readonly path: string; readonly reason: string };

export async function planLauncher(place: CommandPlace): Promise<LauncherPlan> {
  const path = launcherPath(place);
  const state = await launcherState(path);
  if (state === 'foreign') return { action: 'keep', path, reason: `${shown(place, path)} is not Jevris's own, so install leaves it alone` };
  return { action: state === 'ours' ? 'replace' : 'create', path };
}

export type LauncherResult = { readonly ok: true; readonly path: string; readonly action: 'create' | 'replace' } | { readonly ok: false; readonly path: string; readonly reason: string };

/** Writes (or re-points) the launcher at `entry` run by `node`, and records it in the receipt. */
export async function writeLauncher(place: CommandPlace, node: string, entry: string): Promise<LauncherResult> {
  const plan = await planLauncher(place);
  if (plan.action === 'keep') return { ok: false, path: plan.path, reason: plan.reason };
  const dir = launcherDir(place);
  const previous = await readCommandReceipt(place);
  try {
    const made = await makeDirs(dir, place.platform);
    await replaceFile(plan.path, launcherScript(place.platform, node, entry), 0o755);
    const dirCreated = previous !== null && previous.launcher.path === plan.path ? previous.launcher.dirCreated || made.length > 0 : made.length > 0;
    await writeCommandReceipt(place, {
      schemaVersion: 1,
      launcher: { path: plan.path, node, entry, dirCreated },
      profile: previous?.profile ?? null,
      windowsPath: previous?.windowsPath ?? null,
      pathOffer: previous?.pathOffer ?? null,
      createdDirs: mergeDirs(previous?.createdDirs ?? [], made),
    });
    return { ok: true, path: plan.path, action: plan.action };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, path: plan.path, reason: `${shown(place, plan.path)} could not be written (${typeof code === 'string' ? code : 'error'})` };
  }
}

function versionKey(name: string): number[] {
  return name.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : -1));
}

function newerFirst(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * After a partial uninstall the runtime the launcher named may have been pruned: re-point it at
 * the newest runtime copy left. Returns the new entry, or null when nothing changed.
 */
export async function repointLauncher(place: CommandPlace): Promise<string | null> {
  const receipt = await readCommandReceipt(place);
  if (receipt === null || (await exists(receipt.launcher.entry))) return null;
  if ((await launcherState(receipt.launcher.path)) !== 'ours') return null;
  let names: string[];
  try {
    names = (await readdir(runtimeRoot(place.dataRoot))).filter((name) => !name.startsWith('.'));
  } catch {
    return null;
  }
  for (const name of names.sort(newerFirst)) {
    const dir = api(place.platform).join(runtimeRoot(place.dataRoot), name);
    const manifest = await readRuntimeManifest(dir);
    const entry = manifest === null ? null : runtimeEntry(dir, manifest, 'bin');
    if (entry === null || !(await exists(entry))) continue;
    const written = await writeLauncher({ ...place }, receipt.launcher.node, entry);
    return written.ok ? entry : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// PATH

export interface ShellProfile {
  readonly file: string;
  readonly shell: 'zsh' | 'bash' | 'fish' | 'sh';
}

/** zsh: ~/.zprofile; bash: ~/.bash_profile when it exists, else ~/.profile; fish: its conf.d; else ~/.profile. */
export async function shellProfile(home: string, env: EnvLike): Promise<ShellProfile> {
  const shell = posix.basename(envValue(env, 'SHELL', 'linux') ?? '');
  if (shell === 'zsh') return { file: posix.join(home, '.zprofile'), shell: 'zsh' };
  if (shell === 'fish') return { file: posix.join(home, '.config', 'fish', 'conf.d', 'jevris.fish'), shell: 'fish' };
  if (shell === 'bash') {
    const bashProfile = posix.join(home, '.bash_profile');
    return { file: (await exists(bashProfile)) ? bashProfile : posix.join(home, '.profile'), shell: 'bash' };
  }
  return { file: posix.join(home, '.profile'), shell: 'sh' };
}

/** The one line a person adds by hand. */
export function pathLine(shell: ShellProfile['shell']): string {
  return shell === 'fish' ? 'set -gx PATH $HOME/.local/bin $PATH' : 'export PATH="$HOME/.local/bin:$PATH"';
}

export function windowsPathLine(dir: string): string {
  return `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${dir.replace(/'/g, "''")}', 'User')`;
}

/** The marked block install appends (the launcher folder is always ~/.local/bin on POSIX). */
export function profileBlock(shell: ShellProfile['shell']): readonly string[] {
  const body =
    shell === 'fish'
      ? ['if not contains -- "$HOME/.local/bin" $PATH', '    set -gx PATH "$HOME/.local/bin" $PATH', 'end']
      : ['case ":$PATH:" in', '  *":$HOME/.local/bin:"*) ;;', '  *) export PATH="$HOME/.local/bin:$PATH" ;;', 'esac'];
  return [BLOCK_BEGIN, BLOCK_NOTE, ...body, BLOCK_END];
}

async function profileTarget(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return file;
  }
}

/** Appends the block unless a Jevris block is there already. */
export async function addProfileBlock(profile: ShellProfile): Promise<{ readonly added: boolean; readonly created: boolean; readonly createdDirs: readonly string[] }> {
  const target = await profileTarget(profile.file);
  const before = await readCapped(target);
  if (before !== null && before.split(/\r?\n/).includes(BLOCK_BEGIN)) return { added: false, created: false, createdDirs: [] };
  const created = before === null && !(await exists(target));
  if (before === null && !created) throw new Error('profile is not a readable file');
  const text = before ?? '';
  const lead = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  let mode = 0o644;
  if (!created) {
    try {
      mode = (await stat(target)).mode & 0o777;
    } catch {
      /* keep the default */
    }
  }
  const createdDirs = await makeDirs(posix.dirname(target), 'linux');
  await replaceFile(target, `${text}${lead}${profileBlock(profile.shell).join('\n')}\n`, mode);
  return { added: true, created, createdDirs };
}

export type BlockRemoval = 'removed' | 'absent' | 'edited';

/** Removes the exact block install wrote; a changed block is left alone ('edited'). */
export async function removeProfileBlock(file: string, created: boolean, dryRun = false): Promise<BlockRemoval> {
  const target = await profileTarget(file);
  const text = await readCapped(target);
  if (text === null) return 'absent';
  const lines = text.split('\n');
  const begin = lines.indexOf(BLOCK_BEGIN);
  if (begin < 0) return 'absent';
  const end = lines.indexOf(BLOCK_END, begin);
  if (end < 0) return 'edited';
  const found = lines.slice(begin, end + 1).join('\n');
  const known = [profileBlock('fish'), profileBlock('zsh')].some((block) => block.join('\n') === found);
  if (!known) return 'edited';
  if (dryRun) return 'removed';
  // Take the blank line install put before the block too.
  const from = begin > 0 && lines[begin - 1] === '' ? begin - 1 : begin;
  const rest = [...lines.slice(0, from), ...lines.slice(end + 1)].join('\n');
  if (created && rest.trim().length === 0) {
    await rm(target, { force: true });
    return 'removed';
  }
  let mode = 0o644;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch {
    /* keep the default */
  }
  await replaceFile(target, rest, mode);
  return 'removed';
}

function samePathEntry(a: string, b: string, platform: string): boolean {
  const norm = (value: string): string => {
    let out = value.replace(/^"(.*)"$/, '$1');
    out = out.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
    return platform === 'win32' ? out.toLowerCase() : out;
  };
  return norm(a) === norm(b);
}

function pathEntries(env: EnvLike, platform: string): string[] {
  return (envValue(env, 'PATH', platform) ?? '').split(api(platform).delimiter).filter((entry) => entry.length > 0);
}

async function sameFile(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

export async function dirOnPath(dir: string, env: EnvLike, platform: string): Promise<boolean> {
  for (const entry of pathEntries(env, platform)) {
    if (samePathEntry(entry, dir, platform) || (platform === process.platform && (await sameFile(entry, dir)))) return true;
  }
  return false;
}

export type OtherKind = 'npm global install' | 'Jevris launcher from another home' | 'another program';

async function classify(path: string): Promise<OtherKind> {
  let real = path;
  try {
    real = await realpath(path);
  } catch {
    /* keep the path */
  }
  if (/[\\/]node_modules[\\/]@cryptventure[\\/]jevris[\\/]/.test(real)) return 'npm global install';
  const text = await readCapped(path);
  if (text !== null && /node_modules[\\/]@cryptventure[\\/]jevris[\\/]/.test(text)) return 'npm global install';
  if (text !== null && text.includes(LAUNCHER_MARKER)) return 'Jevris launcher from another home';
  return 'another program';
}

export interface CommandView {
  readonly launcher: string;
  readonly state: 'ours' | 'foreign' | 'missing';
  readonly receipt: CommandReceipt | null;
  /** The launcher's folder is on PATH. */
  readonly onPath: boolean;
  /** What `jevris` runs on this PATH, or null. */
  readonly runs: string | null;
  readonly runsKind: 'launcher' | OtherKind | null;
  /** The node or runtime the launcher names is gone. */
  readonly broken: string | null;
}

export interface ViewOptions {
  /** Tests only: true when `path` is a runnable file (Windows fixtures). */
  readonly isExecutableFile?: (path: string) => boolean;
}

export async function commandView(place: CommandPlace, options: ViewOptions = {}): Promise<CommandView> {
  const receipt = await readCommandReceipt(place);
  const launcher = receipt?.launcher.path ?? launcherPath(place);
  const state = await launcherState(launcher);
  const onPath = await dirOnPath(api(place.platform).dirname(launcher), place.env, place.platform);
  const runs = resolveExecutable('jevris', { platform: place.platform, env: place.env, ...(options.isExecutableFile === undefined ? {} : { isExecutableFile: options.isExecutableFile }) });
  let runsKind: CommandView['runsKind'] = null;
  if (runs !== null) runsKind = state === 'ours' && (await sameFile(runs, launcher)) ? 'launcher' : await classify(runs);
  let broken: string | null = null;
  if (state === 'ours' && receipt !== null) {
    if (!(await exists(receipt.launcher.node))) broken = `the Node.js that installed Jevris (${receipt.launcher.node}) is gone`;
    else if (!(await exists(receipt.launcher.entry))) broken = `the runtime it runs (${receipt.launcher.entry}) is gone`;
  }
  return { launcher, state, receipt, onPath, runs, runsKind, broken };
}

// ---------------------------------------------------------------------------------------------
// Windows user PATH (HKCU\Environment)

function defaultRegExec(env: EnvLike): RegExec {
  const root = envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
  const reg = win32.join(root, 'System32', 'reg.exe');
  // Every CLI process start goes through live-harness.ts (shell false, bounded, tree killed).
  return async (args) => {
    const result = await runCaptured(reg, args, { cwd: root, timeoutMs: 15000 });
    return { status: result.spawned && !result.timedOut ? result.code : 1, stdout: result.stdout, stderr: result.stderr };
  };
}

export interface RegistryAccess {
  /** An injected reg.exe stand-in (tests). */
  readonly regExec?: RegExec;
  /** The home is the account's own home: only then may the real user PATH change. */
  readonly accountHome: boolean;
}

/** The reg.exe to use, or null when the user PATH must not be touched from here. */
export function registryPort(place: CommandPlace, access: RegistryAccess): RegExec | null {
  if (access.regExec !== undefined) return access.regExec;
  if (place.platform !== 'win32' || process.platform !== 'win32' || !access.accountHome) return null;
  if (envValue(place.env, 'JEVRIS_TEST', 'win32') === '1') return null;
  return defaultRegExec(place.env);
}

const ENV_KEY = 'HKCU\\Environment';

async function readUserPath(reg: RegExec): Promise<{ readonly value: string; readonly type: 'REG_SZ' | 'REG_EXPAND_SZ' } | null> {
  const result = await reg(['query', ENV_KEY, '/v', 'Path']);
  if (result.status !== 0) return { value: '', type: 'REG_EXPAND_SZ' };
  const match = /^\s*Path\s+(REG_EXPAND_SZ|REG_SZ)\s*(.*)$/im.exec(result.stdout);
  if (match === null) return null;
  return { value: (match[2] ?? '').trim(), type: match[1] === 'REG_SZ' ? 'REG_SZ' : 'REG_EXPAND_SZ' };
}

async function writeUserPath(reg: RegExec, value: string, type: string): Promise<boolean> {
  const result = await reg(['add', ENV_KEY, '/v', 'Path', '/t', type, '/d', value, '/f']);
  return result.status === 0;
}

export async function addWindowsPath(reg: RegExec, dir: string): Promise<'added' | 'present' | 'failed'> {
  const current = await readUserPath(reg);
  if (current === null) return 'failed';
  const entries = current.value.split(';').filter((entry) => entry.length > 0);
  if (entries.some((entry) => samePathEntry(entry, dir, 'win32'))) return 'present';
  return (await writeUserPath(reg, [...entries, dir].join(';'), current.type)) ? 'added' : 'failed';
}

export async function removeWindowsPath(reg: RegExec, dir: string): Promise<'removed' | 'absent' | 'failed'> {
  const current = await readUserPath(reg);
  if (current === null) return 'failed';
  const entries = current.value.split(';').filter((entry) => entry.length > 0);
  const kept = entries.filter((entry) => !samePathEntry(entry, dir, 'win32'));
  if (kept.length === entries.length) return 'absent';
  return (await writeUserPath(reg, kept.join(';'), current.type)) ? 'removed' : 'failed';
}

// ---------------------------------------------------------------------------------------------
// Install: the lines after a successful install, and the one PATH question

export interface SetupInput extends RegistryAccess {
  readonly place: CommandPlace;
  /** An interactive terminal (and not --json): the PATH question may be asked. */
  readonly interactive: boolean;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly isExecutableFile?: (path: string) => boolean;
}

async function recordOffer(place: CommandPlace, receipt: CommandReceipt, patch: Partial<Pick<CommandReceipt, 'profile' | 'windowsPath' | 'pathOffer' | 'createdDirs'>>): Promise<void> {
  await writeCommandReceipt(place, { ...receipt, ...patch });
}

/** What install prints about the `jevris` command; asks the PATH question once on a terminal. */
export async function commandSetup(input: SetupInput): Promise<string[]> {
  const { place } = input;
  const view = await commandView(place, input.isExecutableFile === undefined ? {} : { isExecutableFile: input.isExecutableFile });
  const where = shown(place, view.launcher);
  if (view.state === 'foreign') {
    return [`jevris command: ${where} is not Jevris's own, so install left it alone${view.runs === null ? '' : `; ${view.runs} runs when you type jevris`}`];
  }
  if (view.state === 'missing' || view.receipt === null) return [`jevris command: not written; run ${view.runs === null ? 'node <runtime>/bin/jevris.mjs' : 'jevris'} instead`];
  if (view.runsKind === 'launcher') return [`jevris command: on PATH (${where})`];
  if (view.runs !== null && view.onPath) {
    return [`jevris command: ${view.runs} runs first on PATH (${String(view.runsKind)}); Jevris left it alone. The launcher is ${where}`];
  }
  if (view.runs !== null) {
    return [`jevris command: ${view.runs} runs when you type jevris (${String(view.runsKind)}); Jevris left it alone. The launcher is ${where}, which is not on PATH`];
  }
  const dir = api(place.platform).dirname(view.launcher);
  const receipt = view.receipt;
  if (place.platform === 'win32') {
    const reg = registryPort(place, input);
    if (receipt.windowsPath !== null) return [`jevris command: ${where}; its folder was added to your user PATH, so open a new terminal to use jevris`];
    if (reg !== null && input.interactive && receipt.pathOffer === null) {
      const yes = await input.confirm(`Add ${dir} to your user PATH? [y/N] `);
      if (yes) {
        const added = await addWindowsPath(reg, dir);
        if (added !== 'failed') {
          await recordOffer(place, receipt, { windowsPath: added === 'added' ? { dir } : null, pathOffer: 'accepted' });
          return [`jevris command: ${where}; added ${dir} to your user PATH, so open a new terminal to use jevris`];
        }
        return [`jevris command: not on PATH: the user PATH could not be changed; run this in PowerShell: ${windowsPathLine(dir)}`];
      }
      await recordOffer(place, receipt, { pathOffer: 'declined' });
    }
    return [`jevris command: not on PATH: to use jevris, run this once in PowerShell, then open a new terminal: ${windowsPathLine(dir)}`];
  }
  const profile = await shellProfile(place.home, place.env);
  const recorded = receipt.profile;
  if (recorded !== null) return [`jevris command: ${where}; ${shown(place, dir)} is added to PATH in ${shown(place, recorded.file)}, so open a new terminal to use jevris`];
  if (input.interactive && receipt.pathOffer === null) {
    const yes = await input.confirm(`Add ${shown(place, dir)} to your PATH in ${shown(place, profile.file)}? [y/N] `);
    if (yes) {
      try {
        const added = await addProfileBlock(profile);
        await recordOffer(place, receipt, { profile: added.added ? { file: profile.file, created: added.created } : null, pathOffer: 'accepted', createdDirs: mergeDirs(receipt.createdDirs, added.createdDirs) });
        return [`jevris command: ${where}; added ${shown(place, dir)} to PATH in ${shown(place, profile.file)}, so open a new terminal to use jevris`];
      } catch {
        return [`jevris command: not on PATH: ${shown(place, profile.file)} could not be changed; add this line to it: ${pathLine(profile.shell)}`];
      }
    }
    await recordOffer(place, receipt, { pathOffer: 'declined' });
  }
  return [`jevris command: not on PATH: to use jevris, add this line to ${shown(place, profile.file)}, then open a new terminal: ${pathLine(profile.shell)}`];
}

/** The doctor line, or null when Jevris has no launcher and no install here. */
export async function commandDoctorLine(place: CommandPlace, installed: boolean, options: ViewOptions = {}): Promise<string | null> {
  const view = await commandView(place, options);
  if (view.receipt === null && view.state !== 'ours' && !installed) return null;
  const where = shown(place, view.launcher);
  if (view.state === 'foreign') return `jevris command: ${where} is not Jevris's own, so install left it alone${view.runs === null ? '' : `; ${view.runs} runs when you type jevris`}`;
  if (view.state === 'missing') return 'jevris command: not installed: run jevris install --yes (or node <runtime>/bin/jevris.mjs install --yes)';
  if (view.broken !== null) return `jevris command: broken: ${view.broken}; fix: install Node.js if needed, then run ${REINSTALL}`;
  if (view.runsKind === 'launcher') return `jevris command: on PATH (${where})`;
  if (view.runs !== null) return `jevris command: ${view.runs} runs when you type jevris (${String(view.runsKind)}); the Jevris launcher is ${where}`;
  const dir = api(place.platform).dirname(view.launcher);
  if (place.platform === 'win32') return `jevris command: not on PATH: run this once in PowerShell, then open a new terminal: ${windowsPathLine(dir)}`;
  const profile = view.receipt?.profile?.file ?? (await shellProfile(place.home, place.env)).file;
  const line = pathLine((await shellProfile(place.home, place.env)).shell);
  return `jevris command: not on PATH: add this line to ${shown(place, profile)}, then open a new terminal: ${line}`;
}

// ---------------------------------------------------------------------------------------------
// Uninstall: the last one out removes the launcher, the PATH block and the user PATH entry

export interface RemovalStep {
  readonly action: 'delete' | 'strip' | 'keep' | 'edit';
  readonly path: string;
  readonly detail: string;
}

export interface CommandRemoval {
  readonly steps: readonly RemovalStep[];
  /** What was left and why, with the manual step. */
  readonly nextSteps: readonly string[];
}

const PROFILE_CANDIDATES = ['.zprofile', '.bash_profile', '.profile', '.config/fish/conf.d/jevris.fish'];

export async function removeCommand(place: CommandPlace, access: RegistryAccess & { readonly dryRun?: boolean }): Promise<CommandRemoval> {
  const dryRun = access.dryRun === true;
  const steps: RemovalStep[] = [];
  const nextSteps: string[] = [];
  const receipt = await readCommandReceipt(place);
  const path = api(place.platform);
  const launcher = receipt?.launcher.path ?? launcherPath(place);
  const dir = path.dirname(launcher);
  // 1. The launcher (and a .ps1 beside a .cmd, only with the marker).
  const files = place.platform === 'win32' ? [launcher, path.join(dir, 'jevris.ps1')] : [launcher];
  for (const file of files) {
    const state = await launcherState(file);
    if (state === 'ours') {
      if (!dryRun) await rm(file, { force: true });
      steps.push({ action: 'delete', path: file, detail: 'jevris command' });
    } else if (state === 'foreign' && file === launcher) {
      steps.push({ action: 'keep', path: file, detail: "not Jevris's own" });
      nextSteps.push(`${shown(place, file)} is not Jevris's own, so uninstall left it alone.`);
    }
  }
  // 2. The marked PATH block.
  const profiles = receipt?.profile !== null && receipt?.profile !== undefined ? [receipt.profile] : PROFILE_CANDIDATES.map((name) => ({ file: posix.join(place.home, ...name.split('/')), created: name.endsWith('jevris.fish') }));
  if (place.platform !== 'win32') {
    for (const profile of profiles) {
      let outcome: BlockRemoval;
      try {
        outcome = await removeProfileBlock(profile.file, profile.created, dryRun);
      } catch {
        outcome = 'edited';
      }
      if (outcome === 'removed') steps.push({ action: 'strip', path: profile.file, detail: 'jevris PATH block' });
      if (outcome === 'edited') {
        steps.push({ action: 'keep', path: profile.file, detail: 'jevris PATH block changed by hand' });
        nextSteps.push(`The Jevris PATH block in ${shown(place, profile.file)} was changed by hand, so it was left alone; remove the lines from "${BLOCK_BEGIN}" to "${BLOCK_END}" yourself.`);
      }
    }
  }
  // 3. The Windows user PATH entry, only when the receipt says install added it.
  if (receipt?.windowsPath !== null && receipt?.windowsPath !== undefined) {
    const reg = registryPort(place, access);
    const entry = receipt.windowsPath.dir;
    if (reg === null) {
      nextSteps.push(`Remove ${entry} from your user PATH (it was added by jevris install): ${windowsRemoveLine(entry)}`);
    } else if (dryRun) {
      steps.push({ action: 'edit', path: entry, detail: 'remove from the user PATH (HKCU\\Environment)' });
    } else {
      const removed = await removeWindowsPath(reg, entry);
      if (removed === 'removed') steps.push({ action: 'edit', path: entry, detail: 'removed from the user PATH (HKCU\\Environment)' });
      if (removed === 'failed') nextSteps.push(`The user PATH could not be changed; remove ${entry} from it yourself: ${windowsRemoveLine(entry)}`);
    }
  }
  // 4. Folders install created (~/.local/bin, ~/.local, a fish conf.d, the Windows Jevris\bin),
  // deepest first, each only while it is empty; a folder that was there before is never removed.
  const made = receipt?.createdDirs ?? (place.platform === 'win32' ? [launcherDir(place)] : []);
  for (const folder of [...made].sort((a, b) => b.length - a.length)) {
    const back = path.relative(place.home, folder);
    if (back.length === 0 || back.startsWith('..') || path.isAbsolute(back)) continue;
    try {
      if ((await readdir(folder)).length > 0) continue;
      if (!dryRun) await rmdir(folder);
      steps.push({ action: 'delete', path: folder, detail: 'empty folder jevris install created' });
    } catch {
      /* gone, or not a folder */
    }
  }
  if (!dryRun && receipt !== null) await rm(commandReceiptPath(place), { force: true });
  return { steps, nextSteps };
}

export function windowsRemoveLine(dir: string): string {
  const quoted = dir.replace(/'/g, "''");
  return `[Environment]::SetEnvironmentVariable('Path', (([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ -and $_ -ne '${quoted}' }) -join ';', 'User')`;
}
