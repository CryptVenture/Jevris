/**
 * Domain B commands (runtime, security and data), dispatched from cli.ts before its own
 * argument parsing:
 *
 *   jevris sidecar run [--home <dir>] [--idle-ms <n>] [--supervised]
 *   jevris sidecar start|stop|restart|status [--home <dir>] [--json]
 *   jevris sidecar statusline|metrics [--hours <n>]|diagnose on [--minutes <n>]|off|status
 *   jevris kill-switch status|activate|clear|drill [--reason <text>]
 *   jevris store status|backup <file>|export <file>|restore <file>|migrate [--dry-run]|adopt
 *   jevris audit export <file> | verify
 *   jevris data purge [--dry-run]
 *   jevris authorize <action> --scope <scope> [--ttl-minutes <n>]
 *   jevris service install|uninstall|status [--home <dir>] [--json]
 *
 * Every command answers with lines that tell the user what happened and what to do.
 * Nothing here prints a key, a token or source text.
 */
import { appendFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { jevrisPaths, resolveHome } from '@jevris/platform';

export type Write = (text: string) => void;

export interface RuntimeCommandHooks {
  readonly write?: Write;
  /** Whether stdin and stdout are an interactive terminal (tests inject it). */
  readonly interactive?: () => boolean;
  /** The operator's name for audit rows (default: the OS user). */
  readonly actor?: string;
  /** Runs launchctl, systemctl or schtasks for `jevris service` (tests inject it). */
  readonly serviceExec?: (file: string, args: readonly string[]) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };
  /** The sidecar probe, stop and start `jevris sidecar` and `jevris service install` use (tests inject them). */
  readonly sidecar?: Partial<Pick<typeof import('@jevris/sidecar'), 'probeSidecar' | 'stopSidecarProcess' | 'ensureSidecar'>>;
}

interface Parsed {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

const VALUE_FLAGS = new Set(['--home', '--idle-ms', '--wait-ms', '--reason', '--scope', '--ttl-minutes', '--hours', '--minutes']);
const BOOLEAN_FLAGS = new Set(['--json', '--supervised', '--dry-run', '--yes']);

function parse(argv: readonly string[]): Parsed | undefined {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (VALUE_FLAGS.has(name)) {
        const value = eq >= 0 ? arg.slice(eq + 1) : argv[i + 1];
        if (value === undefined || value.length === 0) return undefined;
        if (eq < 0) i += 1;
        flags.set(name, value);
        continue;
      }
      if (BOOLEAN_FLAGS.has(name) && eq < 0) {
        flags.set(name, true);
        continue;
      }
      return undefined;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function stringFlag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function out(write: Write | undefined, text: string): void {
  if (write !== undefined) write(text);
  else process.stdout.write(text);
}

const SIDECAR_USAGE = 'usage: jevris sidecar start|stop|restart|status|statusline|metrics|diagnose|run [--home <dir>] [--json]\n';

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

const FOREIGN_LOCALITY =
  'The Jevris sidecar for this home runs in another execution environment (a container, WSL or another host). Jevris runs next to the coding process: set JEVRIS_HOME to a directory inside this environment, or stop the other sidecar there.';

/** Where the sidecar, its socket and its store run (IPC-19, US37). */
function localityLines(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  const l = value as Record<string, unknown>;
  const signals = Array.isArray(l['signals']) && l['signals'].length > 0 ? ` (${l['signals'].join(', ')})` : '';
  return [`runs in: ${String(l['kind'])}${signals}`, `data: ${String(l['dataDir'])}`];
}

async function sidecarStatus(home: string | undefined, json: boolean, write: Write | undefined): Promise<number> {
  const sidecar = await import('@jevris/sidecar');
  const probe = await sidecar.probeSidecar(home, 500);
  if (probe.foreign === true) {
    const body = { state: 'foreign-locality', degraded: true, reasonCode: 'FOREIGN_LOCALITY', message: FOREIGN_LOCALITY };
    out(write, json ? `${JSON.stringify(body)}\n` : `sidecar: in another execution environment (degraded: rules-only)\n${body.message}\n`);
    return 1;
  }
  if (!probe.running) {
    const body = {
      state: 'not-running',
      degraded: true,
      message: 'The Jevris sidecar is not running; hooks and commands run rules-only (degraded). Run `jevris sidecar start`.',
    };
    out(write, json ? `${JSON.stringify(body)}\n` : `sidecar: not running (degraded: rules-only)\n${body.message}\n`);
    return 1;
  }
  const health = await sidecar.sidecarRequest({ ...(home !== undefined ? { home } : {}), op: 'health', scope: 'cli', body: {} });
  if (!health.ok) {
    const body = { state: health.reason, degraded: true, reasonCode: health.reasonCode ?? null, message: health.message };
    out(write, json ? `${JSON.stringify(body)}\n` : `sidecar: ${health.reason} (degraded)\n${health.message}\n`);
    return 1;
  }
  const h = health.result as Record<string, unknown>;
  const store = (h['store'] ?? {}) as Record<string, unknown>;
  if (json) {
    out(write, `${JSON.stringify({ state: 'running', degraded: store['state'] !== 'ok', ...h })}\n`);
    return 0;
  }
  const lines = [
    `sidecar: running`,
    `pid: ${String(h['pid'])}`,
    `version: ${String(h['version'])} (protocol ${String(h['protocol'])})`,
    `uptime: ${formatUptime(typeof h['uptimeMs'] === 'number' ? h['uptimeMs'] : 0)}`,
    `endpoint: ${String(h['endpoint'])}`,
    `store: ${String(store['state'])}${typeof store['diagnostic'] === 'string' ? ` (${store['diagnostic']})` : ''}`,
    ...localityLines(h['locality']),
    `kill switch: ${String(h['killSwitch'])}`,
    `decisions: ${h['engine'] === 'ready' ? 'Jev ready' : 'rules-only'}`,
  ];
  out(write, `${lines.join('\n')}\n`);
  return 0;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function latencyText(value: unknown): string {
  const l = rec(value);
  return typeof l['p95'] === 'number' ? `p50 ${num(l['p50'])} ms, p95 ${num(l['p95'])} ms, max ${num(l['max'])} ms (${num(l['count'])})` : 'none';
}

type SidecarModule = typeof import('@jevris/sidecar');
type ServiceExecHook = NonNullable<RuntimeCommandHooks['serviceExec']>;

/** The service unit input for this Node, this Jevris and the given home (IPC-20). */
function serviceInputFor(sidecar: SidecarModule, given: string | undefined) {
  const env = process.env;
  const resolved = resolveHome(given !== undefined ? { home: given } : {});
  const command = sidecar.sidecarCommand();
  const getuid = Reflect.get(process, 'getuid') as (() => number) | undefined;
  const user = env['USERNAME'];
  const input = {
    platform: process.platform as 'darwin' | 'linux' | 'win32',
    osHome: resolveHome({ env: {} }).home,
    stateDir: jevrisPaths(given !== undefined ? { home: given } : {}).state,
    argv: [process.execPath, ...(command ?? []), '--supervised', ...(resolved.source !== 'os' ? ['--home', resolved.home] : [])],
    ...(typeof getuid === 'function' ? { uid: getuid() } : {}),
    ...(typeof user === 'string' ? { windowsUser: typeof env['USERDOMAIN'] === 'string' ? `${env['USERDOMAIN']}\\${user}` : user } : {}),
    env,
  } as const;
  return { input, command };
}

/** Under JEVRIS_TEST=1 no real service manager is called unless a test injects one. */
function serviceExecFor(injected: ServiceExecHook | undefined): ServiceExecHook | undefined {
  if (injected !== undefined || process.env['JEVRIS_TEST'] !== '1') return injected;
  return () => ({ status: 1, stdout: '', stderr: 'service managers are not called under JEVRIS_TEST' });
}

export interface SidecarDoctorView {
  /** running, idle (starts on demand), not-running (degraded), foreign-locality, or the reason the health request failed. */
  readonly state: string;
  readonly degraded: boolean;
  readonly pid: number | null;
  readonly version: string | null;
  readonly uptimeMs: number | null;
  readonly endpoint: string | null;
  /** The store state (ok, refused, missing...) and its content-free diagnostic. */
  readonly store: { readonly state: string; readonly diagnostic: string | null } | null;
  /** The kill switch as the running sidecar reads it, else from the flag files (managed first). */
  readonly killSwitch: string;
  readonly message: string;
  /**
   * A running sidecar's build next to the build installed here (protocol runtimeBuild ids).
   * Absent when not running or when this tree has no bundle; `running` is null for a sidecar
   * that predates build ids. `verificationRuns` are the runs a restart waits for.
   */
  readonly build?: { readonly running: string | null; readonly installed: string; readonly verificationRuns: number };
}

/**
 * IPC-16: the sidecar facts `jevris doctor` shows (pid, version, uptime, endpoint, store health
 * and the kill switch). It never starts a sidecar and never throws.
 */
export async function sidecarDoctorView(home?: string, options: { readonly env?: { readonly [key: string]: string | undefined } } = {}): Promise<SidecarDoctorView> {
  const empty = { pid: null, version: null, uptimeMs: null, endpoint: null, store: null } as const;
  let killSwitch = 'unknown';
  try {
    const ks = await import('./kill-switch.js');
    const flag = await ks.readKillSwitchFlag(home ?? resolveHome({}).home);
    killSwitch = flag.managed.stopped ? 'stopped (managed)' : flag.stopped ? 'stopped' : 'clear';
  } catch {
    killSwitch = 'unreadable (treated as stopped)';
  }
  try {
    const sidecar = await import('@jevris/sidecar');
    const probe = await sidecar.probeSidecar(home, 500);
    if (probe.foreign === true) return { state: 'foreign-locality', degraded: true, ...empty, killSwitch, message: FOREIGN_LOCALITY };
    if (!probe.running) {
      // IPC-16: the sidecar stops when idle and hooks and commands start it on demand
      // (ensureSidecar), so not running is normal. It is degraded only when something is wrong.
      let canStart = false;
      try {
        canStart = sidecar.sidecarCommand() !== undefined;
      } catch {
        canStart = false;
      }
      if (!canStart) {
        return { state: 'not-running', degraded: true, ...empty, killSwitch, message: 'The Jevris sidecar is not running and cannot start on demand: its entry is missing from this install. Hooks and commands run rules-only (degraded). Reinstall Jevris, then run `jevris sidecar start`.' };
      }
      if (probe.endpoint !== undefined) {
        return { state: 'not-running', degraded: true, ...empty, killSwitch, message: 'The Jevris sidecar\'s last run ended without cleaning up (a crash or a kill). The next hook or command starts it again; if this repeats, run `jevris sidecar start` to see why.' };
      }
      // The user's choice (E's cd72b16): hooks and commands never start it, a running one answers.
      const { autostartAllowed } = await import('./public/context.js');
      if (!autostartAllowed(options.env ?? process.env)) {
        return { state: 'not-running', degraded: false, ...empty, killSwitch, message: 'The Jevris sidecar is not running, and autostart is off (JEVRIS_SIDECAR_AUTOSTART=0), so hooks and commands run rules-only until `jevris sidecar start`.' };
      }
      if (killSwitch !== 'clear') {
        return { state: 'idle', degraded: true, ...empty, killSwitch, message: 'The Jevris sidecar is idle, and the kill switch is not clear, so hooks only observe. Run `jevris kill-switch status`.' };
      }
      return { state: 'idle', degraded: false, ...empty, killSwitch, message: 'The Jevris sidecar is idle. It starts on demand when a hook or command needs it, and stops again when idle.' };
    }
    const health = await sidecar.sidecarRequest({ ...(home !== undefined ? { home } : {}), op: 'health', scope: 'cli', body: {} });
    if (!health.ok) return { state: health.reason, degraded: true, ...empty, killSwitch, message: health.message };
    const h = rec(health.result);
    const store = rec(h['store']);
    const storeState = typeof store['state'] === 'string' ? store['state'] : 'unknown';
    const installed = sidecar.runtimeBuild();
    const runningBuild = typeof h['build'] === 'string' && sidecar.BUILD_ID.test(h['build']) ? h['build'] : null;
    const runs = typeof h['verificationRuns'] === 'number' && Number.isSafeInteger(h['verificationRuns']) && h['verificationRuns'] > 0 ? h['verificationRuns'] : 0;
    return {
      ...(installed === null ? {} : { build: { running: runningBuild, installed: installed.id, verificationRuns: runs } }),
      state: 'running',
      degraded: storeState !== 'ok',
      pid: typeof h['pid'] === 'number' ? h['pid'] : null,
      version: typeof h['version'] === 'string' ? h['version'] : null,
      uptimeMs: typeof h['uptimeMs'] === 'number' ? h['uptimeMs'] : null,
      endpoint: typeof h['endpoint'] === 'string' ? h['endpoint'] : null,
      store: { state: storeState, diagnostic: typeof store['diagnostic'] === 'string' ? store['diagnostic'] : null },
      killSwitch: typeof h['killSwitch'] === 'string' ? h['killSwitch'] : killSwitch,
      message: storeState === 'ok' ? 'The Jevris sidecar is running.' : 'The Jevris sidecar is running, but its store is not usable; decisions run rules-only (degraded).',
    };
  } catch {
    return { state: 'unavailable', degraded: true, ...empty, killSwitch, message: 'The Jevris sidecar could not be checked; hooks and commands run rules-only (degraded).' };
  }
}

/** What install and upgrade need from the running sidecar (tests inject stubs; no real sidecar). */
export interface SidecarBuildPorts {
  readonly probe: (home: string) => Promise<{ readonly running: boolean; readonly pid: number | null; readonly supervised: boolean }>;
  readonly health: (home: string) => Promise<{ readonly ok: boolean; readonly result?: unknown }>;
  readonly stop: (home: string) => Promise<{ readonly stopped: boolean }>;
  /** Starts the sidecar (with the wait `jevris sidecar start` gives it); `reasonCode` names why it did not come up. */
  readonly start: (home: string) => Promise<{ readonly ok: boolean; readonly reasonCode?: string }>;
  /** The build a runtime folder holds (protocol runtimeBuild), or null without a bundle. */
  readonly installedBuild: (runtimeDir: string) => { readonly id: string } | null;
}

async function defaultBuildPorts(): Promise<SidecarBuildPorts> {
  const sidecar = await import('@jevris/sidecar');
  return {
    probe: async (home) => {
      const probe = await sidecar.probeSidecar(home, 500);
      return { running: probe.running && probe.foreign !== true, pid: probe.endpoint?.pid ?? null, supervised: probe.endpoint?.supervised === true };
    },
    health: (home) => sidecar.sidecarRequest({ home, op: 'health', scope: 'cli', body: {} }),
    stop: (home) => sidecar.stopSidecarProcess(home),
    start: async (home) => {
      const ensured = await sidecar.ensureSidecar({ home, waitMs: 5000 });
      return ensured.ok ? { ok: true } : { ok: false, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}` };
    },
    installedBuild: (runtimeDir) => sidecar.runtimeBuild(runtimeDir),
  };
}

/**
 * After install or upgrade (owner report: a reinstall of the same version left the old sidecar
 * running the old code): a running sidecar whose build differs from the runtime just installed
 * is moved onto it. Builds are compared by id (a hash of the runtime's bundle manifest), never
 * by the version string.
 * - A sidecar with verification runs under way is left to finish them; it retires itself once
 *   idle (the daemon's build check) and the next hook or command starts the installed build.
 * - A supervised one retires itself the same way, so its service manager starts it again.
 * - Otherwise, and for a sidecar from before build ids (it cannot retire itself), it is stopped
 *   now with the graceful shutdown frame (in-flight requests drain first), and the installed
 *   build is started at once on the same endpoint, so the first hooks after the install are
 *   answered and do not run rules-only.
 * - A sidecar that was not running is not started (autostart on the next hook is unchanged), and
 *   neither is one when JEVRIS_SIDECAR_AUTOSTART=0 is set. A supervised sidecar is never started
 *   next to its service; a service manager restarts only a sidecar that retires itself.
 * - A start that fails never fails the install: the line names the reason code and the fix.
 * Returns the one line to print, or null when no sidecar runs or it already runs this build.
 */
export async function refreshSidecarBuild(input: {
  readonly home: string;
  readonly runtimeDir: string;
  readonly ports?: SidecarBuildPorts;
  /** The environment install runs in (default process.env); only JEVRIS_SIDECAR_AUTOSTART is read. */
  readonly env?: { readonly [key: string]: string | undefined };
}): Promise<string | null> {
  try {
    const ports = input.ports ?? (await defaultBuildPorts());
    const installed = ports.installedBuild(input.runtimeDir);
    if (installed === null) return null;
    const probe = await ports.probe(input.home);
    if (!probe.running) return null;
    const who = probe.pid === null ? 'the sidecar' : `the sidecar (pid ${probe.pid})`;
    const health = await ports.health(input.home);
    if (!health.ok) return `sidecar build: ${who} did not answer, so its build is unknown; if it misbehaves, run jevris sidecar restart`;
    const h = rec(health.result);
    const running = typeof h['build'] === 'string' ? h['build'] : null;
    if (running === installed.id) return null;
    const runs = typeof h['verificationRuns'] === 'number' && Number.isSafeInteger(h['verificationRuns']) && h['verificationRuns'] > 0 ? h['verificationRuns'] : 0;
    // A sidecar that reports a build retires itself once idle; an older one has no such check.
    if (running !== null && runs > 0) {
      return `sidecar build: ${who} runs an older build and is finishing ${runs === 1 ? 'a verification run' : `${runs} verification runs`}; it restarts on the installed build once ${runs === 1 ? 'it ends' : 'they end'}`;
    }
    if (probe.supervised) {
      if (running !== null) return `sidecar build: ${who} runs an older build; its service restarts it on the installed build within a minute, once it is idle`;
      // Stopping it would end it cleanly, and a service manager does not restart a clean exit.
      return `sidecar build: ${who} is supervised and runs a build from before build ids, which cannot retire itself; fix: jevris service install`;
    }
    const stopped = await ports.stop(input.home);
    if (!stopped.stopped) return `sidecar build: ${who} runs an older build and did not stop; fix: jevris sidecar restart`;
    const was = `stopped ${who}, which ran an older build`;
    const { autostartAllowed } = await import('./public/context.js');
    if (!autostartAllowed(input.env ?? process.env)) {
      return `sidecar build: ${was}; autostart is off (JEVRIS_SIDECAR_AUTOSTART=0), so nothing starts the installed build; fix: jevris sidecar start`;
    }
    const started = await ports.start(input.home).catch(() => ({ ok: false as const, reasonCode: 'SIDECAR_UNAVAILABLE' }));
    if (!started.ok) {
      return `sidecar build: ${was}; the installed build did not start (${started.reasonCode ?? 'SIDECAR_UNAVAILABLE'}); fix: the next hook or jevris sidecar start starts it`;
    }
    const after = await ports.health(input.home).catch(() => ({ ok: false as const }));
    const now = after.ok ? rec(after.result)['build'] : undefined;
    if (after.ok && typeof now === 'string' && now !== installed.id) {
      return `sidecar build: ${was}; the sidecar that started runs another build than the installed one (${now}, installed ${installed.id}); fix: jevris sidecar restart`;
    }
    return `sidecar build: restarted ${who} on the installed build (it ran an older build); hooks are answered again at once`;
  } catch {
    return 'sidecar build: the running sidecar could not be checked; if it misbehaves, run jevris sidecar restart';
  }
}

export interface SidecarRemovalResult {
  /** True when no Jevris sidecar for this home is left running. */
  readonly stopped: boolean;
  readonly method: 'not-running' | 'shutdown-frame' | 'signal' | 'failed';
  /** The service unit result when one was asked to be removed (null otherwise). */
  readonly service: { readonly ok: boolean; readonly state: string; readonly message: string } | null;
  readonly message: string;
}

/**
 * IPC-17: stop the sidecar before uninstall or data delete. With `removeService` the per-user
 * service unit (IPC-20) is removed first, so its manager cannot start the sidecar again. A
 * sidecar in another execution environment is never signalled and counts as not stopped.
 */
export async function stopSidecarForRemoval(home?: string, options: { readonly removeService?: boolean; readonly serviceExec?: ServiceExecHook; readonly timeoutMs?: number } = {}): Promise<SidecarRemovalResult> {
  const sidecar = await import('@jevris/sidecar');
  let service: SidecarRemovalResult['service'] = null;
  if (options.removeService === true && (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32')) {
    const result = sidecar.uninstallService(serviceInputFor(sidecar, home).input, serviceExecFor(options.serviceExec));
    service = { ok: result.ok, state: result.state, message: result.message };
  }
  const stopped = await sidecar.stopSidecarProcess(home, options.timeoutMs ?? 5000);
  const message = stopped.foreign === true
    ? 'A Jevris sidecar for this home runs in another execution environment; stop it there first.'
    : stopped.stopped
      ? 'No Jevris sidecar is running for this home.'
      : 'The Jevris sidecar did not stop. Run `jevris sidecar stop`, then retry.';
  return { stopped: stopped.stopped, method: stopped.method, service, message };
}

export type PurgeLearningResult =
  | { readonly ok: true; readonly removed: { readonly [table: string]: number }; readonly via: 'sidecar' | 'store' | 'none' }
  | { readonly ok: false; readonly reasonCode: 'STORE_REFUSED' | 'INVALID_WORKSPACE' | 'SIDECAR_REFUSED' | 'KILL_SWITCH'; readonly message: string };

/**
 * The learning records in the store (decision outcomes, session model changes, advice adherence,
 * latency counters; owner 2026-09-27): for `jevris data delete --scope learning` (with the
 * route-learning folder) and `jevris route learning reset --clear-evidence`. A running sidecar,
 * the store's one writer, removes them and audits it; with none running the store is opened
 * here and the audit row waits in the pending file. With no store there is nothing to remove.
 */
export async function purgeStoreLearning(home: string, options: { readonly workspaceId?: string } = {}): Promise<PurgeLearningResult> {
  if (options.workspaceId !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(options.workspaceId)) {
    return { ok: false, reasonCode: 'INVALID_WORKSPACE', message: 'The workspace id is not a Jevris workspace id.' };
  }
  // GOV-02..04 (JEV-0021): a stopped Jevris removes nothing. Checked here as well, because with no sidecar
  // running this function opens the store itself and never reaches the sidecar's own guard.
  if (await (await import('./kill-switch.js')).readKillSwitchStopped(home)) {
    return { ok: false, reasonCode: 'KILL_SWITCH', message: 'The kill switch is on, so no learning records are removed. Clear the kill switch first (jevris kill-switch clear), then run this again.' };
  }
  const sidecar = await import('@jevris/sidecar');
  const probe = await sidecar.probeSidecar(home, 500);
  if (probe.running && probe.foreign !== true) {
    const res = await sidecar.sidecarRequest({ home, op: 'learning.purge', scope: 'cli', body: options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }, timeoutMs: 10_000 });
    if (!res.ok) return { ok: false, reasonCode: 'SIDECAR_REFUSED', message: `The sidecar did not remove the learning records (${res.reasonCode ?? res.reason}).` };
    const removed = rec(rec(res.result)['removed']);
    return { ok: true, removed: Object.fromEntries(Object.entries(removed).filter((entry): entry is [string, number] => typeof entry[1] === 'number')), via: 'sidecar' };
  }
  const storeApi = await import('@jevris/store');
  const dbPath = join(jevrisPaths({ home }).data, 'jevris.db');
  const inspected = storeApi.inspectStore(dbPath);
  if (inspected.ok && !inspected.exists) return { ok: true, removed: {}, via: 'none' };
  const opened = storeApi.openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', ...sidecar.hostScopeForStore(home, dbPath) });
  if (!opened.ok) return { ok: false, reasonCode: 'STORE_REFUSED', message: `The store could not be opened (${opened.reason}). Run \`jevris doctor\`.` };
  try {
    const deleted = storeApi.deleteLearningRecords(opened, options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId });
    if (!deleted.ok) return { ok: false, reasonCode: 'STORE_REFUSED', message: `The learning records were not removed (${deleted.reason}).` };
    const total = Object.values(deleted.removed).reduce((a, b) => a + b, 0);
    await recordCliAudit('data.delete', { scope: 'learning', removed: total }, home);
    return { ok: true, removed: deleted.removed, via: 'store' };
  } finally {
    storeApi.closeStore(opened);
  }
}

export type PurgeCapsulesResult =
  | { readonly ok: true; readonly removed: number }
  | { readonly ok: false; readonly reasonCode: 'SIDECAR_RUNNING' | 'STORE_REFUSED' | 'INVALID_WORKSPACE'; readonly message: string };

/**
 * DATA-12 `data delete --scope capsules`, the store half: removes the capsule index rows (every
 * workspace's, or one workspace's). The store has one writer, so the sidecar is stopped first and
 * is not restarted here; the audit row waits in the pending file for its next start. The
 * capsule files under `<data>/capsules/` are the caller's to remove.
 */
export async function purgeStoreCapsules(home: string, options: { readonly workspaceId?: string } = {}): Promise<PurgeCapsulesResult> {
  if (options.workspaceId !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(options.workspaceId)) {
    return { ok: false, reasonCode: 'INVALID_WORKSPACE', message: 'The workspace id is not a Jevris workspace id.' };
  }
  const sidecar = await import('@jevris/sidecar');
  const stopped = await sidecar.stopSidecarProcess(home);
  if (!stopped.stopped) return { ok: false, reasonCode: 'SIDECAR_RUNNING', message: 'The Jevris sidecar did not stop. Run `jevris sidecar stop`, then retry.' };
  const storeApi = await import('@jevris/store');
  const dbPath = join(jevrisPaths({ home }).data, 'jevris.db');
  const inspected = storeApi.inspectStore(dbPath);
  if (inspected.ok && !inspected.exists) return { ok: true, removed: 0 };
  const opened = storeApi.openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', ...sidecar.hostScopeForStore(home, dbPath) });
  if (!opened.ok) return { ok: false, reasonCode: 'STORE_REFUSED', message: `The store could not be opened (${opened.reason}). Run \`jevris doctor\`.` };
  try {
    const deleted = storeApi.deleteCapsuleIndex(opened, options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId });
    if (!deleted.ok) return { ok: false, reasonCode: 'STORE_REFUSED', message: `The capsule rows were not removed (${deleted.reason}).` };
    await recordCliAudit('data.delete', { scope: 'capsules', removed: deleted.removed }, home);
    return { ok: true, removed: deleted.removed };
  } finally {
    storeApi.closeStore(opened);
  }
}

/**
 * IPC-20: `jevris service install|uninstall|status`. The unit runs `sidecar run --supervised`
 * with this Node and this Jevris; `--home` (or JEVRIS_HOME) is written into it. Under
 * JEVRIS_TEST=1 no real service manager is ever called.
 */
async function runServiceCommand(parsed: Parsed, write: Write | undefined, hooks: RuntimeCommandHooks | undefined): Promise<number> {
  const sub = parsed.positionals[1];
  const json = parsed.flags.get('--json') === true;
  if (parsed.positionals.length !== 2 || (sub !== 'install' && sub !== 'uninstall' && sub !== 'status')) {
    out(write, `${MY_HELP['service'] ?? ''}\n`);
    return 2;
  }
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    out(write, `jevris service is not available on ${platform}; the sidecar starts on demand.\n`);
    return 1;
  }
  const given = stringFlag(parsed, '--home');
  const sidecar = await import('@jevris/sidecar');
  const planned = serviceInputFor(sidecar, given);
  if (planned.command === undefined && sub === 'install') {
    out(write, 'The Jevris sidecar entry was not found in this installation. Reinstall Jevris, then retry.\n');
    return 1;
  }
  const input = planned.input;
  const exec = serviceExecFor(hooks?.serviceExec);
  // A running supervised sidecar (the service's own) is stopped cleanly first, so the service
  // manager starts it on the new unit: a manager leaves an already-running unit alone
  // (systemctl enable --now, schtasks /Run). An on-demand sidecar is left as it is.
  let stoppedLine: string | null = null;
  if (sub === 'install') {
    const ports = sidecarPorts(sidecar, hooks);
    const probe = await ports.probeSidecar(given, 500);
    if (probe.running && probe.foreign !== true && probe.endpoint?.supervised === true) {
      const stopped = await ports.stopSidecarProcess(given);
      if (!stopped.stopped) {
        out(write, `The sidecar (pid ${String(stopped.pid)}) did not stop, so the service was not changed. Stop that process by hand, then run \`jevris service install\` again.\n`);
        return 1;
      }
      if (stopped.method !== 'not-running') stoppedLine = `sidecar: stopped (pid ${String(stopped.pid)}) so the service can start it`;
    }
  }
  const result = sub === 'install' ? sidecar.installService(input, exec) : sub === 'uninstall' ? sidecar.uninstallService(input, exec) : sidecar.serviceStatus(input, exec);
  if (json) out(write, `${JSON.stringify(result)}\n`);
  else {
    const lines = [...(stoppedLine !== null ? [stoppedLine] : []), ...(stoppedLine !== null && !result.ok ? ['The service was not installed; `jevris sidecar start` starts the sidecar again.'] : []), `service: ${result.state} (${result.manager})`, `unit: ${result.unitPath}`, ...(result.pid !== null ? [`pid: ${String(result.pid)}`] : []), ...result.steps.map((step) => `  ${step.step}: ${step.ok ? 'done' : 'FAILED'}${step.detail !== undefined ? ` (${step.detail})` : ''}`), result.message];
    out(write, `${lines.join('\n')}\n`);
  }
  return result.ok ? 0 : 1;
}

/** OBS-02: the §17.5 counters (decisions from the store, requests since the sidecar started). */
async function sidecarMetrics(parsed: Parsed, home: string | undefined, json: boolean, write: Write | undefined): Promise<number> {
  const hoursRaw = stringFlag(parsed, '--hours');
  if (hoursRaw !== undefined && !/^\d{1,4}$/.test(hoursRaw)) {
    out(write, 'usage: jevris sidecar metrics [--hours <1..2160>] [--home <dir>] [--json]\n');
    return 2;
  }
  const sidecar = await import('@jevris/sidecar');
  const probe = await sidecar.probeSidecar(home, 500);
  if (!probe.running) {
    out(write, json ? `${JSON.stringify({ state: 'not-running' })}\n` : 'sidecar: not running. Run `jevris sidecar start`, then try again.\n');
    return 1;
  }
  const answer = await sidecar.sidecarRequest({ ...(home !== undefined ? { home } : {}), op: 'metrics', scope: 'cli', body: hoursRaw !== undefined ? { sinceHours: Number(hoursRaw) } : {} });
  if (!answer.ok) {
    out(write, `${answer.message}\n`);
    return 1;
  }
  const r = rec(answer.result);
  if (json) {
    out(write, `${JSON.stringify(r)}\n`);
    return 0;
  }
  const d = rec(r['decisions']);
  const q = rec(r['requests']);
  const t = rec(r['traces']);
  const diag = rec(t['diagnostic']);
  const cost = rec(d['costMicroUsd']);
  const tokens = rec(d['tokens']);
  const lines = [`window: last ${num(r['windowHours'])} h`];
  if (r['decisions'] === null) lines.push('decisions: the store is unavailable');
  else {
    lines.push(
      `decisions: ${num(d['decisions'])} (rules-only ${num(d['rulesOnly'])}, with Jev ${num(d['semantic'])})`,
      `abstentions: ${num(d['abstentions'])}; fallbacks to rules: ${num(d['fallbacks'])}; stale: ${num(d['stale'])}; retries: ${num(d['retries'])}`,
      `latency rules: ${latencyText(rec(d['latencyMs'])['rules'])}`,
      `latency Jev: ${latencyText(rec(d['latencyMs'])['semantic'])}`,
      `tokens: ${num(tokens['input'])} in, ${num(tokens['output'])} out (${num(tokens['usageUnknown'])} unknown)`,
      `cost: $${(num(cost['actual']) / 1_000_000).toFixed(4)} actual, $${(num(cost['reserved']) / 1_000_000).toFixed(4)} reserved (${num(cost['actualUnknown'])} not yet reconciled)`,
    );
  }
  lines.push(`requests since start: ${num(q['requests'])} (${num(q['failures'])} failed)`);
  lines.push(`traces: ${String(t['dir'])}${num(t['dropped']) > 0 ? ` (${num(t['dropped'])} lines dropped)` : ''}`);
  lines.push(`diagnostic mode: ${diag['active'] === true ? `on until ${new Date(num(diag['untilMs'])).toISOString()}` : 'off'}`);
  out(write, `${lines.join('\n')}\n`);
  return 0;
}

/** OBS-02: the explicit, temporary diagnostic mode. Turning it on or off is audited. */
async function sidecarDiagnose(parsed: Parsed, home: string | undefined, json: boolean, write: Write | undefined): Promise<number> {
  const action = parsed.positionals[2] ?? 'status';
  const minutesRaw = stringFlag(parsed, '--minutes');
  const usage = 'usage: jevris sidecar diagnose on [--minutes <1..60>] | off | status [--home <dir>] [--json]\n';
  if (parsed.positionals.length > 3 || !['on', 'off', 'status'].includes(action) || (minutesRaw !== undefined && (action !== 'on' || !/^\d{1,2}$/.test(minutesRaw) || Number(minutesRaw) < 1 || Number(minutesRaw) > 60))) {
    out(write, usage);
    return 2;
  }
  const sidecar = await import('@jevris/sidecar');
  if (action === 'status') {
    const probe = await sidecar.probeSidecar(home, 500);
    if (!probe.running) {
      out(write, json ? `${JSON.stringify({ active: false, untilMs: null })}\n` : 'diagnostic mode: off (the sidecar is not running)\n');
      return 0;
    }
    const answer = await sidecar.sidecarRequest({ ...(home !== undefined ? { home } : {}), op: 'metrics', scope: 'cli', body: { sinceHours: 1 } });
    const diag = answer.ok ? rec(rec(rec(answer.result)['traces'])['diagnostic']) : {};
    out(write, json ? `${JSON.stringify({ active: diag['active'] === true, untilMs: diag['untilMs'] ?? null })}\n` : `diagnostic mode: ${diag['active'] === true ? `on until ${new Date(num(diag['untilMs'])).toISOString()}` : 'off'}\n`);
    return 0;
  }
  const answer = await adminRequest(homeOf(parsed), 'diagnostic.set', { minutes: action === 'off' ? 0 : minutesRaw !== undefined ? Number(minutesRaw) : 15, actor: actorName(undefined) });
  if (!answer.ok) {
    out(write, `${answer.message}\n`);
    return 1;
  }
  const active = answer.result['active'] === true;
  out(
    write,
    json
      ? `${JSON.stringify(answer.result)}\n`
      : active
        ? `diagnostic mode: on until ${new Date(num(answer.result['untilMs'])).toISOString()}. Trace lines add sizes and deadlines, never content. It turns itself off; \`jevris sidecar diagnose off\` ends it now.\n`
        : 'diagnostic mode: off\n',
  );
  return 0;
}

async function runSidecarCommand(parsed: Parsed, write: Write | undefined, argv: readonly string[], hooks?: RuntimeCommandHooks): Promise<number> {
  const sub = parsed.positionals[1];
  const home = stringFlag(parsed, '--home');
  const json = parsed.flags.get('--json') === true;
  const sidecar = await import('@jevris/sidecar');
  if (sub === 'run') {
    const rest = argv.slice(argv.indexOf('run') + 1);
    return sidecar.sidecarMain(rest);
  }
  if (sub === 'diagnose') return sidecarDiagnose(parsed, home, json, write);
  if (parsed.positionals.length !== 2) {
    out(write, SIDECAR_USAGE);
    return 2;
  }
  if (sub === 'status') return sidecarStatus(home, json, write);
  if (sub === 'statusline') {
    // OBS-03: read from the cache file the sidecar keeps; never a sidecar round trip.
    const state = jevrisPaths(home !== undefined ? { home } : {}).state;
    const body = sidecar.readStatusLine(state);
    const line = sidecar.statusLineText(body, Date.now());
    out(write, json ? `${JSON.stringify({ line, cache: body ?? null })}\n` : `${line}\n`);
    return 0;
  }
  if (sub === 'metrics') return sidecarMetrics(parsed, home, json, write);
  if (sub === 'stop' || sub === 'restart' || sub === 'start') return sidecarLifecycle(sub, parsed, home, sidecar, write, hooks);
  out(write, SIDECAR_USAGE);
  return 2;
}

/** The sidecar functions the lifecycle commands call: the real ones, or a test's. */
function sidecarPorts(sidecar: SidecarModule, hooks: RuntimeCommandHooks | undefined) {
  return {
    probeSidecar: hooks?.sidecar?.probeSidecar ?? sidecar.probeSidecar,
    stopSidecarProcess: hooks?.sidecar?.stopSidecarProcess ?? sidecar.stopSidecarProcess,
    ensureSidecar: hooks?.sidecar?.ensureSidecar ?? sidecar.ensureSidecar,
  };
}

/** Waits for the sidecar the service manager was asked to start; true once it answers. */
async function awaitServiceStart(ports: ReturnType<typeof sidecarPorts>, home: string | undefined, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const probe = await ports.probeSidecar(home, 300);
    if (probe.running && probe.foreign !== true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((done) => setTimeout(() => done(), 100));
  }
}

const SERVICE_FIX = 'Run `jevris service status` to see why, and `jevris service install` to register it again.';

/**
 * `jevris sidecar stop|restart|start`. A sidecar the service manager supervises is never
 * replaced by an unsupervised one: the manager does not restart a clean exit (launchd
 * SuccessfulExit false, systemd Restart=on-failure), so a restart stops it cleanly and asks the
 * manager to start it again, and a start with nothing running asks the manager first.
 */
async function sidecarLifecycle(sub: 'stop' | 'restart' | 'start', parsed: Parsed, home: string | undefined, sidecar: SidecarModule, write: Write | undefined, hooks: RuntimeCommandHooks | undefined): Promise<number> {
  const ports = sidecarPorts(sidecar, hooks);
  const waitRaw = stringFlag(parsed, '--wait-ms');
  const waitMs = waitRaw !== undefined && /^\d{1,6}$/.test(waitRaw) ? Number(waitRaw) : 5000;
  const platform = process.platform;
  const managerPossible = platform === 'darwin' || platform === 'linux' || platform === 'win32';
  const service = (): { readonly input: ReturnType<typeof serviceInputFor>['input']; readonly exec: ServiceExecHook | undefined } => ({ input: serviceInputFor(sidecar, home).input, exec: serviceExecFor(hooks?.serviceExec) });
  const probe = await ports.probeSidecar(home, 500);
  const supervised = probe.running && probe.foreign !== true && probe.endpoint?.supervised === true;

  if (sub === 'restart' && supervised) {
    // Check the manager before anything is stopped: a refusal leaves the running sidecar alone.
    const { input, exec } = service();
    const ready = managerPossible ? sidecar.serviceReady(input, exec) : undefined;
    if (ready === undefined || !ready.ok) {
      const why = ready?.message ?? 'There is no service manager on this platform.';
      out(write, `sidecar restart refused (SERVICE_UNREACHABLE): the sidecar runs under a service manager and it could not be reached. ${why} Nothing was stopped. ${SERVICE_FIX}\n`);
      return 1;
    }
  }

  if (sub === 'stop' || sub === 'restart') {
    const stopped = await ports.stopSidecarProcess(home);
    if (stopped.foreign === true) {
      out(write, `${FOREIGN_LOCALITY}\n`);
      return 1;
    }
    if (!stopped.stopped) {
      out(write, `The sidecar (pid ${String(stopped.pid)}) did not stop. Stop that process by hand, then run \`jevris sidecar start\`.\n`);
      return 1;
    }
    if (sub === 'stop') {
      out(write, stopped.method === 'not-running' ? 'sidecar: not running\n' : `sidecar: stopped (pid ${String(stopped.pid)})\n`);
      if (supervised) out(write, 'The service manager does not restart a clean stop. `jevris sidecar start` starts it again through the service; it also starts at the next login.\n');
      return 0;
    }
  }

  // Start through the service manager when this home's unit is installed and answers.
  // A restart of a supervised sidecar has no other path: it never spawns an unsupervised one.
  if (managerPossible && (sub === 'restart' ? supervised : !probe.running)) {
    const { input, exec } = service();
    const started = sidecar.startService(input, exec);
    if (started.ok) {
      if (await awaitServiceStart(ports, home, waitMs)) {
        out(write, `sidecar: running (${sub === 'restart' ? 'restarted' : 'started'} by ${started.manager})\n`);
        return 0;
      }
      out(write, `${started.manager} was asked to start the sidecar, but it did not answer within ${String(waitMs)} ms (SERVICE_START_TIMEOUT). Run \`jevris service status\`, then \`jevris sidecar status\`.\n`);
      return 1;
    }
    if (sub === 'restart') {
      const detail = started.steps.find((step) => !step.ok)?.detail;
      out(write, `The sidecar was stopped, but ${started.manager} did not start it (SERVICE_START_FAILED${detail !== undefined ? `: ${detail}` : ''}). ${SERVICE_FIX}\n`);
      return 1;
    }
    // start: no unit for this home, or the manager does not answer; an on-demand start below.
  }

  const ensured = await ports.ensureSidecar({ ...(home !== undefined ? { home } : {}), waitMs });
  if (!ensured.ok) {
    out(write, `${ensured.message}\n`);
    return 1;
  }
  out(write, `sidecar: running (${ensured.started ? 'started' : 'already running'})\n`);
  return 0;
}

// ------------------------------------------------------------------ shared helpers

const MY_HELP: { readonly [command: string]: string } = {
  sidecar: [
    'Usage: jevris sidecar start|stop|restart|status|statusline|metrics|diagnose [--home <dir>] [--json] [--wait-ms <n>]',
    'Manages the local Jevris service. Hooks, MCP tools and commands start it on demand.',
    '  status      pid, version, uptime, endpoint, store and kill-switch state (exit 1 when not running)',
    '  start       start it now, or report that it is already running',
    '  stop        ask it to finish in-flight work and exit',
    '  restart     stop, then start',
    '  statusline  one line from the local cache, for a status line command (no sidecar call)',
    '  metrics     decisions, abstentions, fallbacks, latency, tokens and cost [--hours <n>, default 24]',
    '  diagnose    on [--minutes <1..60>] | off | status: temporary extra trace detail, never content',
  ].join('\n'),
  'kill-switch': [
    'Usage: jevris kill-switch status|activate|clear|drill [--reason <text>] [--home <dir>] [--json]',
    'Stops every Jevris effect on this machine: hooks, sidecar ops and CLI actions.',
    '  status    whether the switch is stopped, and who set it when',
    '  activate  stop now; pending owned effects are held for reconciliation and audited',
    '  clear     resume; needs an interactive terminal and is never available over MCP',
    '  drill     check that the switch works, restore the previous state, and record the drill',
  ].join('\n'),
  store: [
    'Usage: jevris store status|backup <file>|export <file>|restore <file>|migrate [--dry-run]|adopt [--home <dir>]',
    'The local Jevris database.',
    '  status    schema version, filesystem and health',
    '  backup    a consistent, owner-only, integrity-checked copy (the file must not exist)',
    '  export    every durable table as JSON lines, without authorization secrets',
    '  restore   stop the sidecar, check the backup (integrity, host, schema), then install it; the store only:',
    '            decision records under <data>/decisions are left as they are',
    '  migrate   apply pending schema migrations; --dry-run lists them and changes nothing',
    '  adopt     mark your own store in this home as this machine\'s after a network name change',
    '            made it look copied; interactive terminal only, asks you to type yes',
  ].join('\n'),
  audit: [
    'Usage: jevris audit export <file> | verify [--home <dir>]',
    'The append-only, hash-chained audit log of policy, kill-switch, egress, credential and data events.',
    '  export    write the log as JSON lines (no secrets); the file must not exist',
    '  verify    check the hash chain; exit 1 names the first tampered row',
    '            both read the store file directly when no sidecar is running (and it is not started when',
    '            JEVRIS_SIDECAR_AUTOSTART=0), and both work while the kill switch is on',
  ].join('\n'),
  data: [
    'Usage: jevris data purge [--dry-run] [--home <dir>]',
    '       jevris data delete [--scope <list>] [--dry-run] [--home <dir>] [--json]',
    '  purge     apply the retention policy now (7 days raw, 30 days decisions by default)',
    '  delete    delete Jevris data on this machine (local deletion is not vendor deletion);',
    '            jevris help data delete lists its scopes and flags',
  ].join('\n'),
  service: [
    'Usage: jevris service install|uninstall|status [--home <dir>] [--json]',
    'Runs the sidecar as a per-user service: a LaunchAgent on macOS, a systemd user unit on Linux,',
    'a Scheduled Task at logon on Windows. The service restarts the sidecar if it crashes; a clean',
    '`jevris sidecar stop` is respected. Without a service the sidecar still starts on demand.',
    '  install    write the unit and start it',
    '  uninstall  stop it and remove the unit',
    '  status     whether it is installed and running',
  ].join('\n'),
  authorize: [
    'Usage: jevris authorize <action> --scope <scope> [--ttl-minutes <n>] [--home <dir>]',
    'Mints a single-use authorization from an interactive terminal (never from MCP, a hook or a file).',
    'Actions: task.exception, kill-switch.clear, data.delete, policy.change, credential.set, budget.increase (scope: the budget id).',
    'The receipt expires after --ttl-minutes (default 5, at most 15).',
  ].join('\n'),
};

function homeOf(parsed: Parsed): string {
  const given = stringFlag(parsed, '--home');
  return resolveHome(given !== undefined ? { home: given } : {}).home;
}

function actorName(hooks: RuntimeCommandHooks | undefined): string {
  const name = hooks?.actor ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'cli';
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 63);
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `u${cleaned}`.slice(0, 64);
}

function isInteractive(hooks: RuntimeCommandHooks | undefined): boolean {
  if (hooks?.interactive !== undefined) return hooks.interactive();
  return process.stdin.isTTY === true && Reflect.get(process.stdout, 'isTTY') === true;
}

type AdminAnswer = { readonly ok: true; readonly result: Record<string, unknown> } | { readonly ok: false; readonly reasonCode: string; readonly message: string };

/** One admin request through the sidecar (started on demand; it is the store's only writer). */
async function adminRequest(home: string, op: string, body: Record<string, unknown>): Promise<AdminAnswer> {
  const sidecar = await import('@jevris/sidecar');
  // JEV-0018: JEVRIS_SIDECAR_AUTOSTART=0 means no command starts the sidecar; a running one answers.
  const { autostartAllowed } = await import('./public/context.js');
  if (!autostartAllowed(process.env) && !(await sidecar.probeSidecar(home, 500)).running) {
    return { ok: false, reasonCode: 'SIDECAR_AUTOSTART_OFF', message: 'The Jevris sidecar is not running and autostart is off (JEVRIS_SIDECAR_AUTOSTART=0), so this command did not start it. Start it with `jevris sidecar start`, then run this again.' };
  }
  const ensured = await sidecar.ensureSidecar({ home, waitMs: 5000 });
  if (!ensured.ok) return { ok: false, reasonCode: 'SIDECAR_UNAVAILABLE', message: ensured.message };
  const res = await sidecar.sidecarRequest({ home, op, scope: 'cli', body, timeoutMs: 60_000 });
  if (!res.ok) return { ok: false, reasonCode: res.reasonCode ?? res.reason, message: res.message };
  const result = res.result !== null && typeof res.result === 'object' ? (res.result as Record<string, unknown>) : {};
  return { ok: true, result };
}

/**
 * GOV-10: records an audit row for a CLI action (credential set and clear, policy changes, egress approve and revoke).
 * Through the running sidecar, the store's only writer; with no sidecar running the row waits
 * in a private file under the state directory, and the sidecar appends it at its next start
 * with the original time. Content-free detail only. Never throws: the action already happened.
 */
export async function recordCliAudit(kind: 'credential.set' | 'credential.remove' | 'policy.change' | 'data.delete' | 'egress.enable' | 'egress.revoke', detail: Record<string, string | number | boolean> = {}, home?: string): Promise<void> {
  const actor = actorName(undefined);
  try {
    const sidecar = await import('@jevris/sidecar');
    const probe = await sidecar.probeSidecar(home, 500);
    if (probe.running) {
      const res = await sidecar.sidecarRequest({ ...(home !== undefined ? { home } : {}), op: 'audit.record', scope: 'cli', body: { kind, actor, channel: 'cli', detail }, timeoutMs: 5000 });
      if (res.ok) return;
    }
  } catch {
    // fall through to the pending file
  }
  try {
    const paths = jevrisPaths(home !== undefined ? { home } : {});
    await mkdir(paths.state, { recursive: true, mode: 0o700 });
    const file = join(paths.state, 'audit-pending.jsonl');
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      size = 0;
    }
    if (size > 256 * 1024) return;
    await appendFile(file, `${JSON.stringify({ kind, actor, atMs: Date.now(), detail })}\n`, { mode: 0o600 });
  } catch {
    // best effort: the action itself succeeded
  }
}

/** An admin request only when the sidecar is already running (never starts it). */
async function adminIfRunning(home: string, op: string, body: Record<string, unknown>): Promise<AdminAnswer | null> {
  const sidecar = await import('@jevris/sidecar');
  const probe = await sidecar.probeSidecar(home, 500);
  if (!probe.running) return null;
  return adminRequest(home, op, body);
}

function absolute(path: string): string {
  return resolve(path);
}

function report(write: Write | undefined, json: boolean, body: Record<string, unknown>, lines: readonly string[]): void {
  out(write, json ? `${JSON.stringify(body)}\n` : `${lines.join('\n')}\n`);
}

// ------------------------------------------------------------------ kill switch (GOV-02..04)

async function runKillSwitchCommand(parsed: Parsed, write: Write | undefined, hooks: RuntimeCommandHooks | undefined): Promise<number> {
  const sub = parsed.positionals[1];
  const home = homeOf(parsed);
  const json = parsed.flags.get('--json') === true;
  const ks = await import('./kill-switch.js');
  if (parsed.positionals.length !== 2) {
    out(write, `${MY_HELP['kill-switch'] ?? ''}\n`);
    return 2;
  }
  if (sub === 'status') {
    const flag = await ks.readKillSwitchFlag(home);
    const state = flag.stopped ? 'stopped' : 'clear';
    const managed = flag.managed;
    const detail = flag.state === 'unreadable' ? 'the flag file is damaged, so Jevris treats it as stopped' : flag.at !== null ? `${flag.recorded === 'cleared' ? 'cleared' : 'set'} ${flag.at} by ${flag.actor ?? 'unknown'} via ${flag.channel ?? 'unknown'}${flag.reason !== null ? ` (${flag.reason})` : ''}` : 'no flag set';
    const managedLine = managed.stopped
      ? managed.refused !== null
        ? `your organization's kill switch file failed its ownership check (${managed.refused}), so Jevris treats it as stopped; ask your administrator`
        : `stopped by your organization (${managed.source === 'registry' ? 'policy registry' : 'managed file'})${managed.reason !== null ? `: ${managed.reason}` : ''}; only an administrator can lift it`
      : null;
    report(write, json, { state, flag: flag.state, recorded: flag.recorded ?? null, at: flag.at, actor: flag.actor, channel: flag.channel, reason: flag.reason, managed }, [
      `kill switch: ${state}`,
      ...(managedLine !== null ? [managedLine] : []),
      `your flag: ${detail}`,
      managed.stopped ? 'Your own flag cannot lift the organization kill switch.' : flag.stopped ? 'Resume with `jevris kill-switch clear` from an interactive terminal.' : 'Stop every Jevris effect with `jevris kill-switch activate`.',
    ]);
    return 0;
  }
  if (sub === 'activate') {
    const actor = actorName(hooks);
    const reason = stringFlag(parsed, '--reason');
    const result = await ks.activateKillSwitch({
      home,
      actor,
      channel: isInteractive(hooks) ? 'terminal' : 'cli',
      ...(reason !== undefined ? { reason } : {}),
      afterFlag: async ({ policyRestored }) => {
        const answer = await adminIfRunning(home, 'kill-switch.activate', { actor, channel: isInteractive(hooks) ? 'terminal' : 'cli', ...(reason !== undefined ? { reason } : {}), ...(policyRestored !== null ? { policyRestored } : {}) });
        if (answer === null) return [{ step: 'store', ok: true, detail: 'sidecar not running; pending effects are held when it next starts' }];
        if (!answer.ok) return [{ step: 'store', ok: false, detail: answer.reasonCode }];
        const held = Array.isArray(answer.result['held']) ? answer.result['held'].length : 0;
        return [{ step: 'store', ok: true, detail: `${String(held)} pending effect(s) held for reconciliation; audit row ${String(answer.result['auditSeq'])}` }];
      },
    });
    const failed = result.steps.filter((step) => !step.ok);
    report(write, json, { stopped: result.stopped, steps: result.steps, policyRestored: result.policyRestored }, [
      result.stopped ? 'kill switch: stopped' : 'kill switch: NOT stopped',
      ...result.steps.map((step) => `  ${step.step}: ${step.ok ? 'done' : 'FAILED'}${step.detail !== undefined ? ` (${step.detail})` : ''}`),
      failed.length === 0 ? 'Every Jevris effect is stopped. Resume with `jevris kill-switch clear`.' : result.stopped ? 'Jevris is stopped, but some steps did not complete; run `jevris doctor`.' : 'The flag could not be written. Check that the Jevris config directory is writable, then retry.',
    ]);
    return result.stopped ? 0 : 1;
  }
  if (sub === 'clear') {
    if (!isInteractive(hooks)) {
      out(write, 'Refused: `jevris kill-switch clear` needs an interactive terminal. It is never available over MCP, a hook or a script.\n');
      return 2;
    }
    const actor = actorName(hooks);
    const cleared = await ks.clearKillSwitch({ home, actor });
    if (cleared.cleared) await adminIfRunning(home, 'audit.record', { kind: 'kill-switch.clear', actor, channel: 'terminal' });
    report(write, json, { cleared: cleared.cleared, managedStopped: cleared.managedStopped }, [
      cleared.cleared
        ? 'kill switch: clear (Jevris effects may resume)'
        : cleared.managedStopped
          ? "kill switch: still stopped by your organization's kill switch. Your own flag is clear, but only an administrator can lift the organization's."
          : 'kill switch: still stopped; the flag could not be written. Check the Jevris config directory.',
    ]);
    return cleared.cleared ? 0 : 1;
  }
  if (sub === 'drill') {
    const actor = actorName(hooks);
    const scratch = await mkdtemp(join(tmpdir(), 'jevris-drill-'));
    try {
      const sidecar = await import('@jevris/sidecar');
      const drilled = await ks.drillKillSwitch({
        home,
        actor,
        scratchHome: scratch,
        probe: async () => {
          const probe = await sidecar.probeSidecar(home, 500);
          if (!probe.running) return null;
          const res = await sidecar.sidecarRequest({ home, op: 'kill-switch.status', scope: 'cli', body: {} });
          return res.ok && (res.result as Record<string, unknown>)['killSwitch'] === 'stopped';
        },
      });
      if (drilled.passed) await adminIfRunning(home, 'audit.record', { kind: 'kill-switch.drill', actor, channel: isInteractive(hooks) ? 'terminal' : 'cli', detail: { passed: true } });
      report(write, json, { passed: drilled.passed, recorded: drilled.recorded, checks: drilled.checks }, [
        `kill-switch drill: ${drilled.passed ? 'passed' : 'FAILED'}`,
        ...drilled.checks.map((check) => `  ${check.step}: ${check.ok ? 'ok' : 'FAILED'}${check.detail !== undefined ? ` (${check.detail})` : ''}`),
        drilled.passed ? (drilled.recorded ? 'The drill record was written; the previous switch state is restored.' : 'The drill passed but its record could not be written.') : 'No drill record was written. Fix the failed check and run the drill again.',
      ]);
      return drilled.passed && drilled.recorded ? 0 : 1;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  out(write, `${MY_HELP['kill-switch'] ?? ''}\n`);
  return 2;
}

// ------------------------------------------------------------------ store (DATA-01, DATA-13)

async function runStoreCommand(parsed: Parsed, write: Write | undefined, hooks: RuntimeCommandHooks | undefined): Promise<number> {
  const sub = parsed.positionals[1];
  const home = homeOf(parsed);
  const json = parsed.flags.get('--json') === true;
  const dbPath = join(jevrisPaths({ home }).data, 'jevris.db');
  const fileArg = parsed.positionals[2];
  const needsFile = sub === 'backup' || sub === 'export' || sub === 'restore';
  if (sub === 'adopt' && parsed.positionals.length === 2) return runStoreAdopt(home, dbPath, json, write, hooks);
  if (sub === undefined || (needsFile ? parsed.positionals.length !== 3 || fileArg === undefined : parsed.positionals.length !== 2)) {
    out(write, `${MY_HELP['store'] ?? ''}\n`);
    return 2;
  }
  if (sub === 'status') {
    const answer = await adminIfRunning(home, 'store.health', {});
    const storeApi = await import('@jevris/store');
    const inspected = storeApi.inspectStore(dbPath);
    const health = answer !== null && answer.ok ? answer.result : null;
    const version = inspected.ok && inspected.exists ? inspected.schemaVersion : null;
    report(write, json, { path: dbPath, exists: inspected.ok ? inspected.exists : true, schemaVersion: version, health }, [
      `store: ${dbPath}`,
      inspected.ok ? (inspected.exists ? `schema version ${String(inspected.schemaVersion)} (latest ${String(inspected.targetVersion)})` : 'not created yet (the sidecar creates it on first start)') : `not readable (${inspected.reason}); run \`jevris store restore <backup>\``,
      health !== null ? `sidecar view: ${String(health['state'])}${typeof health['diagnostic'] === 'string' ? ` - ${health['diagnostic']}` : ''}` : 'sidecar: not running',
    ]);
    return inspected.ok ? 0 : 1;
  }
  if (sub === 'backup' || sub === 'export') {
    const target = absolute(fileArg ?? '');
    const answer = await adminRequest(home, sub === 'backup' ? 'store.backup' : 'store.export', { path: target, actor: actorName(hooks) });
    if (!answer.ok) {
      out(write, `store ${sub}: refused (${answer.reasonCode}). ${pathAdvice(answer.reasonCode)}\n`);
      return answer.reasonCode.startsWith('PATH_') ? 2 : 1;
    }
    report(write, json, answer.result, [sub === 'backup' ? `store backup: written to ${target} (owner-only, integrity checked)` : `store export: ${String(answer.result['rows'])} rows from ${String(answer.result['tables'])} tables written to ${target}`]);
    return 0;
  }
  if (sub === 'restore' || sub === 'migrate') {
    const storeApi = await import('@jevris/store');
    const sidecarModule = await import('@jevris/sidecar');
    const dryRun = parsed.flags.get('--dry-run') === true;
    if (sub === 'migrate' && dryRun) {
      const inspected = storeApi.inspectStore(dbPath);
      if (!inspected.ok) {
        out(write, `store migrate: cannot plan (${inspected.reason}).\n`);
        return 1;
      }
      if (!inspected.exists) {
        report(write, json, { exists: false, pending: [] }, ['store migrate: no store yet; nothing to migrate.']);
        return 0;
      }
      report(write, json, inspected, [
        `store migrate (dry run): schema ${String(inspected.schemaVersion)} -> ${String(inspected.targetVersion)}`,
        ...(inspected.pending.length === 0 ? ['  nothing pending'] : inspected.pending.map((step) => `  ${String(step.version)} ${step.name}${step.destructive ? ' (destructive: a backup is taken first)' : ''}`)),
        'Nothing was changed.',
      ]);
      return 0;
    }
    // Both need the single writer: stop the sidecar first.
    const stopped = await sidecarModule.stopSidecarProcess(home);
    if (!stopped.stopped) {
      out(write, `store ${sub}: the sidecar (pid ${String(stopped.pid)}) did not stop. Stop it, then retry.\n`);
      return 1;
    }
    const { hostScope, adoptHostScopes } = sidecarModule.hostScopeForStore(home, dbPath);
    if (sub === 'restore') {
      const backupPath = absolute(fileArg ?? '');
      // DATA-10: a backup under an earlier host-name scope of this machine is accepted when it
      // is this user's file in this home; the restore installs it with this machine's scope.
      const earlier = sidecarModule.storeBelongsHere(home, backupPath) ? sidecarModule.legacyHostScopes(home).filter((scope) => scope !== hostScope) : [];
      const restored = storeApi.restoreStore({ backupPath, dbPath, hostScope, nowMs: Date.now(), adoptHostScopes: earlier });
      if (!restored.ok) {
        out(write, `store restore: refused (${restored.reason}). ${restoreAdvice(restored.reason)}\n`);
        return 1;
      }
      report(write, json, restored, [`store restore: installed (schema ${String(restored.restoredSchemaVersion)}).`, restored.previousMovedTo !== null ? `The previous store was kept at ${restored.previousMovedTo}.` : 'There was no previous store.', `Decision records in ${join(dirname(dbPath), 'decisions')} were not changed.`, 'The sidecar migrates it on its next start.']);
      await recordAfterRestart(home, 'store.restore', actorName(hooks), { schemaVersion: restored.restoredSchemaVersion });
      return 0;
    }
    const before = storeApi.inspectStore(dbPath);
    const opened = storeApi.openStore({ path: dbPath, role: 'sidecar', workspaceId: 'host', hostScope, adoptHostScopes });
    if (!opened.ok) {
      out(write, `store migrate: refused (${opened.reason}). Run \`jevris store migrate --dry-run\` and \`jevris doctor\`.\n`);
      return 1;
    }
    const after = opened.schemaVersion;
    storeApi.closeStore(opened);
    report(write, json, { from: before.ok && before.exists ? before.schemaVersion : 0, to: after }, [`store migrate: schema ${String(before.ok && before.exists ? before.schemaVersion : 0)} -> ${String(after)}.`]);
    await recordAfterRestart(home, 'store.migrate', actorName(hooks), { schemaVersion: after });
    return 0;
  }
  out(write, `${MY_HELP['store'] ?? ''}\n`);
  return 2;
}

/**
 * DATA-10 `jevris store adopt`: re-stamps this user's store in this home with this machine's
 * scope, after the store was refused as copied (host-scope-mismatch) because its scope came
 * from an earlier network name. Interactive terminal only, with a typed confirmation, never
 * under JEVRIS_TEST, and only for a regular file owned by this user inside this home.
 */
async function runStoreAdopt(home: string, dbPath: string, json: boolean, write: Write | undefined, hooks: RuntimeCommandHooks | undefined): Promise<number> {
  if (process.env['JEVRIS_TEST'] === '1') {
    out(write, 'Refused: `jevris store adopt` is never run under JEVRIS_TEST.\n');
    return 2;
  }
  if (!isInteractive(hooks)) {
    out(write, 'Refused: `jevris store adopt` needs an interactive terminal. It is never available over MCP, a hook or a script.\n');
    return 2;
  }
  const storeApi = await import('@jevris/store');
  const sidecarModule = await import('@jevris/sidecar');
  const inspected = storeApi.inspectStore(dbPath);
  if (inspected.ok && !inspected.exists) {
    out(write, `store adopt: there is no store at ${dbPath}; nothing to adopt.\n`);
    return 1;
  }
  if (!sidecarModule.storeBelongsHere(home, dbPath)) {
    out(write, `store adopt: refused. ${dbPath} is not a regular file owned by you inside this home; it is not adopted. Move it aside instead.\n`);
    return 1;
  }
  out(write, [
    `store adopt: ${dbPath}`,
    'This marks the store as this machine\'s, so the sidecar opens it again. Do this only if the store',
    'was created on this machine by you (it was refused after a network name change). A store copied',
    'from another machine or user must be moved aside instead.',
    '',
  ].join('\n'));
  if (!(await askOnTerminal('Adopt this store? Type yes to continue: '))) {
    out(write, 'store adopt: not confirmed; nothing was changed.\n');
    return 1;
  }
  const stopped = await sidecarModule.stopSidecarProcess(home);
  if (!stopped.stopped) {
    out(write, `store adopt: the sidecar (pid ${String(stopped.pid)}) did not stop. Stop it, then retry.\n`);
    return 1;
  }
  const adopted = storeApi.adoptStoreHostScope({ dbPath, hostScope: sidecarModule.hostScopeId(home), nowMs: Date.now(), actor: actorName(hooks) });
  if (!adopted.ok) {
    out(write, `store adopt: refused (${adopted.reason}). ${adopted.reason === 'writer-busy' ? 'Another Jevris process holds the store; stop it and retry.' : adopted.reason === 'store-corrupt' ? 'The store failed its integrity check; run `jevris store restore <backup>`.' : 'Run `jevris doctor`.'}\n`);
    return 1;
  }
  report(write, json, { adopted: adopted.changed, schemaVersion: adopted.schemaVersion }, [
    adopted.changed ? 'store adopt: done; the store now carries this machine\'s identity (audited as store.adopt).' : 'store adopt: the store already carries this machine\'s identity; nothing was changed.',
    'Run `jevris sidecar start` (hooks also start it on demand, unless JEVRIS_SIDECAR_AUTOSTART=0).',
  ]);
  return 0;
}

/** Reads one line from the terminal; true only for `yes`. */
async function askOnTerminal(question: string): Promise<boolean> {
  process.stdout.write(question);
  return new Promise((resolveAnswer) => {
    const onData = (chunk: Uint8Array): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      const Ctor = (globalThis as unknown as { TextDecoder?: new () => { decode(input?: Uint8Array): string } }).TextDecoder;
      const answer = Ctor === undefined ? '' : new Ctor().decode(chunk);
      resolveAnswer(/^\s*yes\s*$/i.test(answer));
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function recordAfterRestart(home: string, kind: string, actor: string, detail: Record<string, number>): Promise<void> {
  try {
    await adminRequest(home, 'audit.record', { kind, actor, channel: 'cli', detail });
  } catch {
    // The operation itself succeeded; the audit row is best effort once the sidecar returns.
  }
}

function pathAdvice(code: string): string {
  switch (code) {
    case 'PATH_EXISTS':
      return 'Choose a file name that does not exist yet.';
    case 'PATH_OUTSIDE_HOME':
      return 'Write it inside your home directory.';
    case 'PATH_SYMLINK':
      return 'The folder is reached through a symbolic link; use its real path.';
    case 'PATH_PARENT_MISSING':
    case 'PATH_PARENT_NOT_DIRECTORY':
      return 'Create the folder first.';
    case 'SIDECAR_AUTOSTART_OFF':
      return 'Autostart is off (JEVRIS_SIDECAR_AUTOSTART=0); run `jevris sidecar start` first.';
    default:
      return 'Run `jevris sidecar status` and `jevris doctor`.';
  }
}

function restoreAdvice(reason: string): string {
  switch (reason) {
    case 'writer-busy':
      return 'Another Jevris process holds the store; stop it and retry.';
    case 'backup-corrupt':
      return 'The backup failed its integrity check; use another backup.';
    case 'backup-foreign-host':
      return 'The backup belongs to another machine or user and is refused.';
    case 'schema-newer':
      return 'The backup was written by a newer Jevris; upgrade Jevris first.';
    default:
      return 'Check the file path and permissions.';
  }
}

// ------------------------------------------------------------------ audit (GOV-10)

async function runAuditCommand(parsed: Parsed, write: Write | undefined): Promise<number> {
  const sub = parsed.positionals[1];
  const home = homeOf(parsed);
  const json = parsed.flags.get('--json') === true;
  if (sub === 'export' && parsed.positionals.length === 3) {
    const target = absolute(parsed.positionals[2] ?? '');
    const asked = await adminRequest(home, 'audit.export', { path: target });
    // JEV-0018: with autostart off and no sidecar running, the log is read from the store file, read-only.
    const answer = !asked.ok && asked.reasonCode === 'SIDECAR_AUTOSTART_OFF' ? await auditExportFromFile(home, target) : asked;
    if (!answer.ok) {
      out(write, `audit export: refused (${answer.reasonCode}). ${pathAdvice(answer.reasonCode)}\n`);
      return answer.reasonCode.startsWith('PATH_') ? 2 : 1;
    }
    report(write, json, answer.result, [`audit export: ${String(answer.result['rows'])} rows written to ${target}`]);
    return 0;
  }
  if (sub === 'verify' && parsed.positionals.length === 2) {
    const asked = await adminRequest(home, 'audit.verify', {});
    // JEV-0018: the same read-only fallback; verifying never starts the sidecar and never writes.
    const answer = !asked.ok && asked.reasonCode === 'SIDECAR_AUTOSTART_OFF' ? await auditVerifyFromFile(home) : asked;
    if (!answer.ok) {
      out(write, `audit verify: unavailable (${answer.reasonCode}). ${answer.message}\n`);
      return 1;
    }
    const intact = answer.result['intact'] === true;
    report(write, json, answer.result, [intact ? `audit log: intact (${String(answer.result['count'])} rows${answer.result['via'] === 'store-file' ? '; read from the store file, the sidecar is not running' : ''})` : `audit log: TAMPERED at row ${String(answer.result['brokenAt'])}. Keep the store file for review and run \`jevris store backup\`.`]);
    return intact ? 0 : 1;
  }
  out(write, `${MY_HELP['audit'] ?? ''}\n`);
  return 2;
}

/** The store-file failures the audit fallback reports, as the reason codes the sidecar's own refusals use. */
function auditFileRefusal(reason: 'store-unreadable' | 'store-corrupt', what: string): AdminAnswer {
  return { ok: false, reasonCode: reason === 'store-corrupt' ? 'STORE_CORRUPT' : 'STORE_UNREADABLE', message: `The store file could not be read to ${what}. Run \`jevris doctor\`.` };
}

/** `audit verify` with no sidecar running: the chain is walked over the store file, opened read-only (JEV-0018). */
async function auditVerifyFromFile(home: string): Promise<AdminAnswer> {
  const storeApi = await import('@jevris/store');
  const checked = storeApi.verifyAuditChainAt(join(jevrisPaths({ home }).data, 'jevris.db'));
  if ('brokenAt' in checked) return { ok: true, result: { intact: false, brokenAt: checked.brokenAt, via: 'store-file' } };
  if (checked.ok) return { ok: true, result: { intact: true, count: checked.count, head: checked.head, via: 'store-file' } };
  // No store file yet: there is no audit log, so nothing can be tampered with.
  if (checked.reason === 'no-store') return { ok: true, result: { intact: true, count: 0, via: 'store-file' } };
  return auditFileRefusal(checked.reason, 'verify the audit log');
}

/** `audit export` with no sidecar running: the same path rules and private file as the sidecar's op, read from the store file. */
async function auditExportFromFile(home: string, path: string): Promise<AdminAnswer> {
  const sidecar = await import('@jevris/sidecar');
  const refused = sidecar.outputPathRefusal(home, path);
  if (refused !== undefined) return { ok: false, reasonCode: refused, message: 'The output path was refused.' };
  const storeApi = await import('@jevris/store');
  const read = storeApi.exportAuditJsonlAt(join(jevrisPaths({ home }).data, 'jevris.db'));
  if (!read.ok && read.reason !== 'no-store') return auditFileRefusal(read.reason, 'export the audit log');
  const text = read.ok ? read.text : '';
  if (!sidecar.writeNewPrivate(path, text)) return { ok: false, reasonCode: 'PATH_REFUSED', message: 'The output file could not be created (it may already exist).' };
  return { ok: true, result: { path, rows: text.length === 0 ? 0 : text.trimEnd().split('\n').length, via: 'store-file' } };
}

// ------------------------------------------------------------------ data purge (DATA-11)

async function runDataPurge(parsed: Parsed, write: Write | undefined, hooks: RuntimeCommandHooks | undefined): Promise<number> {
  const home = homeOf(parsed);
  const json = parsed.flags.get('--json') === true;
  const dryRun = parsed.flags.get('--dry-run') === true;
  const answer = await adminRequest(home, 'data.purge', { dryRun, actor: actorName(hooks) });
  if (!answer.ok) {
    // GOV-02..04 (JEV-0021): a purge refused because the kill switch is on is a refusal, not an outage.
    if (answer.reasonCode === 'KILL_SWITCH') {
      out(write, `data purge: refused (KILL_SWITCH). ${answer.message}\n`);
      return 2;
    }
    out(write, `data purge: unavailable (${answer.reasonCode}). ${answer.message}\n`);
    return 1;
  }
  const removed = (answer.result['removed'] ?? {}) as Record<string, number>;
  const total = Object.values(removed).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const policy = (answer.result['policy'] ?? {}) as Record<string, number>;
  report(write, json, answer.result, [
    `data purge${dryRun ? ' (dry run)' : ''}: ${String(total)} records and ${String(answer.result['rawFiles'])} raw files ${dryRun ? 'would be removed' : 'removed'}`,
    ...fileRetentionLines(answer.result, dryRun),
    ...journalLines(answer.result, dryRun),
    `retention: raw artifacts ${String(policy['rawArtifactRetentionDays'])} days, decisions ${String(policy['decisionRetentionDays'])} days; pinned memory, route learning and live-evidence demotions kept`,
    ...(dryRun ? ['Nothing was changed.'] : []),
  ]);
  return 0;
}

/** JEV-0023: the decision journal files `explain` reads; an unknown effect is kept, never counted as removed. */
function journalLines(result: Record<string, unknown>, dryRun: boolean): string[] {
  const journal = result['decisionJournal'];
  if (typeof journal !== 'object' || journal === null) return [];
  const count = (name: string): number => {
    const value = (journal as Record<string, unknown>)[name];
    return typeof value === 'number' ? value : 0;
  };
  const kept = count('keptForReconciliation');
  return [`decision journal: ${String(count('removed'))} records ${dryRun ? 'would be removed' : 'removed'}${kept > 0 ? `; ${String(kept)} kept until their cost is reconciled` : ''}`];
}

/** DATA-11: the orchestration history, worker runs, live evidence and calibration cases the purge covers. */
function fileRetentionLines(result: Record<string, unknown>, dryRun: boolean): string[] {
  const orchestration = (result['orchestration'] ?? {}) as Record<string, number>;
  const ledger = Object.values(orchestration).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const live = typeof result['liveEvidence'] === 'number' ? result['liveEvidence'] : 0;
  const cases = typeof result['calibrationCases'] === 'number' ? result['calibrationCases'] : 0;
  if (!('orchestration' in result)) return [];
  return [`orchestration history and worker runs: ${String(ledger)} records; live evidence: ${String(live)} lines; local calibration cases: ${String(cases)} files ${dryRun ? 'would be removed' : 'removed'}`];
}

// ------------------------------------------------------------------ authorize (GOV-09)

async function runAuthorize(parsed: Parsed, write: Write | undefined, hooks: RuntimeCommandHooks | undefined): Promise<number> {
  const action = parsed.positionals[1];
  const scope = stringFlag(parsed, '--scope');
  const ttlRaw = stringFlag(parsed, '--ttl-minutes') ?? '5';
  if (action === undefined || parsed.positionals.length !== 2 || scope === undefined || !/^\d{1,2}$/.test(ttlRaw)) {
    out(write, `${MY_HELP['authorize'] ?? ''}\n`);
    return 2;
  }
  if (!isInteractive(hooks)) {
    out(write, 'Refused: an authorization is minted only from an interactive terminal, never from MCP, a hook, a script or repository text.\n');
    return 2;
  }
  const home = homeOf(parsed);
  const ttlMs = Number(ttlRaw) * 60_000;
  const answer = await adminRequest(home, 'authorization.mint', { actionClass: action, scope, ttlMs, actor: actorName(hooks), channel: 'terminal' });
  if (!answer.ok) {
    if (answer.reasonCode === 'KILL_SWITCH') {
      out(write, `authorize: refused (KILL_SWITCH). ${answer.message}\n`);
      return 2;
    }
    out(write, `authorize: refused (${answer.reasonCode}). The action must be one of the listed classes, the scope a plain name, and the time at most 15 minutes.\n`);
    return 2;
  }
  report(write, parsed.flags.get('--json') === true, answer.result, [`authorized: ${action} on ${scope}, single use, until ${new Date(Number(answer.result['expiresAtMs'])).toISOString()}`, `id: ${String(answer.result['authorizationId'])}`]);
  return 0;
}

/**
 * Returns an exit code when the command is one of domain B's, else undefined so cli.ts
 * handles it.
 */
export async function runRuntimeCommand(argv: readonly string[], write?: Write, hooks?: RuntimeCommandHooks): Promise<number | undefined> {
  const command = argv[0];
  if (command === 'help' && argv.length === 2 && argv[1] !== undefined && Object.hasOwn(MY_HELP, argv[1])) {
    out(write, `${MY_HELP[argv[1]] ?? ''}\n`);
    return 0;
  }
  const mine = command === 'sidecar' || command === 'kill-switch' || command === 'store' || command === 'audit' || command === 'authorize' || command === 'service' || (command === 'data' && argv[1] === 'purge');
  if (!mine || command === undefined) return undefined;
  if (argv.includes('--help') || argv.includes('-h')) {
    out(write, `${MY_HELP[command] ?? ''}\n`);
    return 0;
  }
  const parsed = parse(command === 'sidecar' && argv[1] === 'run' ? argv.slice(0, 2) : argv);
  if (parsed === undefined) {
    out(write, `${MY_HELP[command] ?? SIDECAR_USAGE}\n`);
    return 2;
  }
  const w = write ?? hooks?.write;
  switch (command) {
    case 'sidecar':
      return runSidecarCommand(parsed, w, argv, hooks);
    case 'kill-switch':
      return runKillSwitchCommand(parsed, w, hooks);
    case 'store':
      return runStoreCommand(parsed, w, hooks);
    case 'audit':
      return runAuditCommand(parsed, w);
    case 'authorize':
      return runAuthorize(parsed, w, hooks);
    case 'service':
      return runServiceCommand(parsed, w, hooks);
    default:
      return runDataPurge(parsed, w, hooks);
  }
}
