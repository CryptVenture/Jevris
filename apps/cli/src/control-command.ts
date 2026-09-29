/**
 * `jevris control` (ORC-12): one lease authority across hosts, through D's control service.
 *
 *   jevris control status     whether this host leases through a control service, the service
 *                             URL (never the token), whether it answers with this host's token,
 *                             and whether the workspace was migrated
 *   jevris control migrate    a person's one-way move of this workspace's lease state to the
 *                             configured service (CLI only; the kill switch stops it)
 *   jevris control serve      run the service on an operator host until SIGINT or SIGTERM
 *
 * The bearer token is read only from an owner-only file named in `<config>/control.json`; it is
 * never taken from argv, the environment or the JSON. Every sidecar answer is checked before it
 * is shown.
 */
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { homeRefusal } from './public/home-guard.js';
import { defaultPorts } from './public/ports.js';
import { authorized, contextFor, parse, type VerifyAdminOptions } from './verify-admin.js';

type Write = (text: string) => void;

export const CONTROL_HELP = `Usage: jevris control status [--json]
       jevris control migrate [--yes] [--json]
       jevris control serve --root <dir> --tenants <file> [--host <addr>] [--port <n>]
                            [--tls-key <file> --tls-cert <file>]

Owned workers on several hosts share one lease authority: a control service. Without one,
each host leases on its own (single host).

status   Whether this host uses a control service, its URL, whether the service accepts
         this host's token, how many leases it holds for this workspace, and whether this
         workspace was migrated. Unusable settings are named. It never starts anything.
migrate  Moves this workspace's budgets, leases, reservations and fences to the configured
         service, once; it cannot be undone. Afterwards this host grants no local lease for
         the workspace: owned work runs only while the service answers. It needs --yes or a
         y/N answer on a terminal. Only the CLI can migrate; the kill switch stops it.
serve    Runs the control service on this host until you stop it (Ctrl-C or SIGTERM). Tenants
         come from a file { "tenants": [{ "id": "team-a", "tokenSha256": "<hex>" }] }: only
         token digests are stored. Plain HTTP is served on a loopback address only; any other
         address needs --tls-key and --tls-cert.

Host setup: write <config dir>/control.json as
  { "schemaVersion": "jevris-control-client-1", "url": "https://host:port/",
    "tokenFile": "<absolute path>", "caFile": "<absolute path, optional>" }
The token file must be readable by you only (0600 on macOS and Linux; an owner-only ACL on
Windows). The token never goes in a command line or in control.json.

Options:
  --root <dir>        serve: the service's data directory (one ledger per tenant)
  --tenants <file>    serve: the tenants file (token digests only)
  --host <addr>       serve: the address to listen on (default 127.0.0.1)
  --port <n>          serve: the port to listen on
  --tls-key <file>    serve: the TLS private key (PEM)
  --tls-cert <file>   serve: the TLS certificate (PEM)
  --yes               migrate: confirm without the terminal question
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line

Exit codes: 0 single host or the service answers, migrated, or served until stopped; 1 the
service is unusable, not migrated, or the sidecar is not running; 2 usage error, not
confirmed, or the service could not start.

Examples:
  jevris control status
  jevris control migrate --yes
  jevris control serve --root /srv/jevris-control --tenants /srv/jevris-control/tenants.json --host 0.0.0.0 --port 8443 --tls-key key.pem --tls-cert cert.pem`;

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
const STATUS_CODES = new Set(['SINGLE_HOST', 'CONTROL_SERVICE', 'CONTROL_SERVICE_REQUIRED', 'CONTROL_SETTINGS_UNUSABLE', 'CONTROL_TOKEN_UNUSABLE', 'CONTROL_UNAUTHORIZED', 'CONTROL_UNAVAILABLE']);
const MIGRATE_CODES = new Set(['MIGRATED', 'ALREADY_MIGRATED', 'IMPORT_CONFLICT', 'CONTROL_NOT_CONFIGURED', 'CONTROL_SETTINGS_UNUSABLE', 'CONTROL_UNAVAILABLE', 'CONTROL_UNAUTHORIZED']);
const TEXT_CAP = 2048;

type Rec = { readonly [key: string]: unknown };
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const textOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length > 0 && v.length <= TEXT_CAP && !v.includes('\0'));

export interface ControlStatusView {
  readonly configured: boolean;
  readonly url: string | null;
  readonly problem: string | null;
  readonly reachable: boolean | null;
  readonly activeLeases: number | null;
  readonly migrated: boolean;
  readonly reasonCode: string;
}

/** D's control.status body, checked field by field; null when it does not match. */
export function checkControlStatus(raw: unknown): ControlStatusView | null {
  if (!isRec(raw)) return null;
  const { configured, url, problem, reachable, activeLeases, migrated, reasonCode } = raw;
  if (typeof configured !== 'boolean' || typeof migrated !== 'boolean' || typeof reasonCode !== 'string' || !STATUS_CODES.has(reasonCode)) return null;
  if (!textOrNull(url) || !textOrNull(problem) || !(reachable === null || typeof reachable === 'boolean')) return null;
  if (!(activeLeases === undefined || activeLeases === null || count(activeLeases))) return null;
  if (url !== null && !/^https?:\/\//.test(url)) return null;
  return { configured, url, problem, reachable, activeLeases: activeLeases ?? null, migrated, reasonCode };
}

const STATUS_TEXT: { readonly [code: string]: string } = {
  SINGLE_HOST: 'This host leases on its own (single host); no control service is configured.',
  CONTROL_SERVICE: 'This host leases through the control service.',
  CONTROL_SERVICE_REQUIRED: 'This workspace was migrated to a control service, but this host has no control.json: it grants no lease here until you configure one.',
  CONTROL_SETTINGS_UNUSABLE: 'control.json is not usable, so no lease is granted through a service.',
  CONTROL_TOKEN_UNUSABLE: 'The token file is not usable (it must be owner-only and hold the token).',
  CONTROL_UNAUTHORIZED: 'The control service refused this host\'s token.',
  CONTROL_UNAVAILABLE: 'The control service did not answer.',
};

export function renderControlStatus(v: ControlStatusView): string[] {
  const lines = [STATUS_TEXT[v.reasonCode] ?? v.reasonCode];
  if (v.url !== null) lines.push(`service: ${v.url}`);
  if (v.problem !== null) lines.push(`problem: ${v.problem}`);
  if (v.reachable !== null) lines.push(`reachable: ${v.reachable ? 'yes' : 'no'}`);
  if (v.activeLeases !== null) lines.push(`active leases for this workspace: ${String(v.activeLeases)}`);
  lines.push(`migrated: ${v.migrated ? 'yes' : 'no'}`);
  return lines;
}

const MIGRATE_TEXT: { readonly [code: string]: string } = {
  ALREADY_MIGRATED: 'this workspace was already migrated',
  IMPORT_CONFLICT: 'the service already holds different state for this workspace',
  CONTROL_NOT_CONFIGURED: 'no control service is configured; write <config dir>/control.json first',
  CONTROL_SETTINGS_UNUSABLE: 'control.json is not usable',
  CONTROL_UNAVAILABLE: 'the control service did not answer',
  CONTROL_UNAUTHORIZED: 'the control service refused this host\'s token',
};

function actorName(): string | undefined {
  try {
    const name = userInfo().username;
    return ACTOR.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

export interface ControlServeHooks {
  /** Resolves when the process should stop (SIGINT or SIGTERM by default). */
  readonly stopped?: () => Promise<string>;
}

/** The process's signal events (the CLI's own Node typings declare only what it uses). */
type SignalEmitter = { on(event: string, listener: () => void): unknown; off(event: string, listener: () => void): unknown };

function waitForSignal(): Promise<string> {
  const proc = process as unknown as SignalEmitter;
  return new Promise((resolve) => {
    const done = (signal: string) => {
      proc.off('SIGINT', onInt);
      proc.off('SIGTERM', onTerm);
      resolve(signal);
    };
    const onInt = () => done('SIGINT');
    const onTerm = () => done('SIGTERM');
    proc.on('SIGINT', onInt);
    proc.on('SIGTERM', onTerm);
  });
}

/** Runs `jevris control ...` (argv after `control`). */
export async function runControlCommand(argv: readonly string[], write: Write, options: VerifyAdminOptions & ControlServeHooks = {}): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${CONTROL_HELP}\n`);
    return argv.length === 0 ? COMMAND_EXIT_CODES.usage : COMMAND_EXIT_CODES.ok;
  }
  const sub = argv[0];
  const parsed = parse(argv.slice(1), ['--home', '--workspace', '--root', '--tenants', '--host', '--port', '--tls-key', '--tls-cert'], ['--yes', '--json']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help control for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (sub !== 'status' && sub !== 'migrate' && sub !== 'serve') return usage(`Unknown control subcommand ${String(sub).slice(0, 40)}. Use jevris control status, migrate or serve.`);
  if (typeof parsed === 'string') return usage(parsed);
  if (parsed.positionals.length > 0) return usage(`jevris control ${sub} takes no positional arguments.`);
  const serveFlags = ['--root', '--tenants', '--host', '--port', '--tls-key', '--tls-cert'];
  if (sub !== 'serve' && serveFlags.some((f) => parsed.values.has(f))) return usage(`${serveFlags.join(', ')} apply only to jevris control serve.`);
  if (sub !== 'migrate' && parsed.flags.has('--yes')) return usage('--yes applies only to migrate.');
  const out = (command: string, result: object, lines: readonly string[], code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command, ...result })}\n` : `${lines.join('\n')}\n`);
    return code;
  };

  if (sub === 'serve') return runServe(parsed.values, write, json, usage, out, options);

  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const command = `control ${sub}`;
  if (sub === 'migrate' && !(await authorized(parsed, options, 'Move this workspace\'s leases and budgets to the control service? This cannot be undone: this host then grants no local lease for the workspace, and owned work runs only while the service answers. [y/N] ', write, json, 'This moves lease state to the control service for good, and this host then grants no local lease for the workspace'))) {
    return COMMAND_EXIT_CODES.usage;
  }
  const nothing = sub === 'migrate' ? 'nothing was migrated' : 'nothing is shown';
  // Status never starts anything: without a running sidecar it says so.
  if (sub === 'migrate' && ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: 5000 });
    if (!ensured.ok) return out(command, { reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}` }, [`The Jevris sidecar is not running, so ${nothing}. Start it with jevris sidecar start and retry.`], COMMAND_EXIT_CODES.negative);
  }
  const actor = actorName();
  if (sub === 'migrate' && actor === undefined) return usage('Your OS user name cannot name the person who migrates; run it as a named user.');
  const answer = await ctx.ports.sidecar.request({
    home: ctx.home,
    op: sub === 'status' ? 'control.status' : 'control.migrate',
    workspace: ctx.workspaceRoot,
    body: sub === 'status' ? {} : { actor },
    scope: 'cli',
    timeoutMs: ctx.requestTimeoutMs,
    budget: 'hot',
  });
  if (!answer.ok) {
    const code = answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`;
    const down = code === 'NOT_RUNNING' || answer.reason === 'unavailable';
    const hint = code === 'KILL_SWITCH' ? ' The kill switch is stopped; clear it first with jevris kill-switch clear.' : down ? ' The Jevris sidecar is not running; start it with jevris sidecar start and retry.' : '';
    return out(command, { reasonCode: code }, [`${nothing[0]?.toUpperCase() ?? ''}${nothing.slice(1)} (${code}).${hint}`], COMMAND_EXIT_CODES.negative);
  }
  const invalid = () => out(command, { reasonCode: 'SIDECAR_INVALID_RESULT' }, ['The sidecar answered in an unexpected shape, so nothing is shown. Run jevris status.'], COMMAND_EXIT_CODES.negative);
  if (sub === 'status') {
    const view = checkControlStatus(answer.result);
    if (view === null) return invalid();
    const healthy = view.reasonCode === 'SINGLE_HOST' || view.reasonCode === 'CONTROL_SERVICE';
    return out(command, view, renderControlStatus(view), healthy ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
  }
  const raw = answer.result;
  if (!isRec(raw) || typeof raw['migrated'] !== 'boolean' || typeof raw['reasonCode'] !== 'string' || !MIGRATE_CODES.has(raw['reasonCode']) || raw['migrated'] !== (raw['reasonCode'] === 'MIGRATED')) return invalid();
  const importedRaw = raw['imported'];
  let imported: { budgets: number; leases: number; reservations: number; fences: number } | null = null;
  if (importedRaw !== null) {
    if (!isRec(importedRaw) || !count(importedRaw['budgets']) || !count(importedRaw['leases']) || !count(importedRaw['reservations']) || !count(importedRaw['fences'])) return invalid();
    imported = { budgets: importedRaw['budgets'], leases: importedRaw['leases'], reservations: importedRaw['reservations'], fences: importedRaw['fences'] };
  }
  const problem = raw['problem'];
  if (problem !== undefined && !textOrNull(problem)) return invalid();
  const reasonCode = raw['reasonCode'];
  const migrated = raw['migrated'];
  const lines = migrated
    ? [
        'This workspace now leases through the control service; this host grants no local lease for it.',
        ...(imported === null ? [] : [`moved: ${String(imported.budgets)} budgets, ${String(imported.leases)} leases, ${String(imported.reservations)} reservations, ${String(imported.fences)} fences`]),
      ]
    : [`Nothing was migrated: ${MIGRATE_TEXT[reasonCode] ?? reasonCode}.`, ...(typeof problem === 'string' ? [`problem: ${problem}`] : [])];
  return out(command, { migrated, reasonCode, imported, ...(typeof problem === 'string' ? { problem } : {}) }, lines, migrated ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
}

async function runServe(
  values: ReadonlyMap<string, string>,
  write: Write,
  json: boolean,
  usage: (message: string) => number,
  out: (command: string, result: object, lines: readonly string[], code: number) => number,
  hooks: ControlServeHooks,
): Promise<number> {
  const root = values.get('--root');
  const tenantsFile = values.get('--tenants');
  if (root === undefined || tenantsFile === undefined) return usage('jevris control serve needs --root <dir> and --tenants <file>.');
  const portRaw = values.get('--port');
  if (portRaw !== undefined && !/^[0-9]{1,5}$/.test(portRaw)) return usage('--port is a number from 0 to 65535.');
  const port = portRaw === undefined ? undefined : Number(portRaw);
  if (port !== undefined && port > 65_535) return usage('--port is a number from 0 to 65535.');
  const keyFile = values.get('--tls-key');
  const certFile = values.get('--tls-cert');
  if ((keyFile === undefined) !== (certFile === undefined)) return usage('Give both --tls-key and --tls-cert, or neither.');
  const host = values.get('--host');
  const read = (file: string, what: string): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      usage(`Cannot read the ${what} file ${file}.`);
      return null;
    }
  };
  const tenantsText = read(tenantsFile, 'tenants');
  if (tenantsText === null) return COMMAND_EXIT_CODES.usage;
  let tls: { key: string; cert: string } | undefined;
  if (keyFile !== undefined && certFile !== undefined) {
    const key = read(keyFile, 'TLS key');
    if (key === null) return COMMAND_EXIT_CODES.usage;
    const cert = read(certFile, 'TLS certificate');
    if (cert === null) return COMMAND_EXIT_CODES.usage;
    tls = { key, cert };
  }
  const orchestrator = await import('@jevris/orchestrator');
  let service: { readonly url: string; close(): Promise<void> };
  try {
    const tenants = orchestrator.tenantsFromJson(tenantsText);
    service = await orchestrator.startControlService({ root, tenants, ...(host === undefined ? {} : { host }), ...(port === undefined ? {} : { port }), ...(tls === undefined ? {} : { tls }) });
  } catch (error) {
    // D's messages name the rule that was broken (tenants, TLS); they never carry a token.
    const message = error instanceof Error ? error.message.slice(0, 300) : 'the service could not start';
    return out('control serve', { reasonCode: 'SERVE_REFUSED', message }, [`The control service did not start: ${message}`], COMMAND_EXIT_CODES.usage);
  }
  out('control serve', { serving: true, url: service.url }, [`Serving the control service at ${service.url}. Stop it with Ctrl-C.`], COMMAND_EXIT_CODES.ok);
  const signal = await (hooks.stopped ?? waitForSignal)();
  await service.close();
  if (!json) write(`Stopped (${signal}).\n`);
  return COMMAND_EXIT_CODES.ok;
}
