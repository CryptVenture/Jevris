import { parseArgs } from 'node:util';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { resolveHome as platformResolveHome } from '@jevris/platform';
import {
  GLOBAL_HARNESSES,
  installGlobal,
  normalizeHarness,
  packageRoot,
  uninstallGlobal,
  type GlobalHarness,
  type HarnessCli,
  type ServiceExec,
  type OperationReport,
  type PlannedChange,
} from './global-harness.js';
import type { RegExec } from './command-launcher.js';
import type { SidecarBuildPorts } from './runtime-commands.js';
import type { OpenHostSecret } from './credential.js';
import { testHomeRefusal } from './home-guard.js';
import { PACK_HELP } from './pack-help.js';

/**
 * Administration commands (ADM-01..06): install, uninstall, data delete, doctor, certify.
 * cli.ts dispatches here with one line. `--home` is optional on every command (default
 * JEVRIS_HOME, else the OS home, ADM-01) and the resolved home is printed; `--json` prints one
 * JSON document. With JEVRIS_TEST=1 a command without an explicit temporary home is refused
 * (home-guard.ts), so tests never reach the real home.
 *
 * install: `--dry-run` prints the plan per file and changes nothing; `--yes` applies it.
 * Without either, an interactive terminal is asked to confirm, and a non-interactive run
 * prints the plan, changes nothing and exits 2.
 */

const ADMIN_COMMANDS = new Set(['install', 'uninstall', 'doctor', 'certify', 'data', 'pack']);

export interface AdminHooks {
  readonly afterSettingsRead?: () => void | Promise<void>;
  readonly afterConfigRead?: (path: string) => void | Promise<void>;
  readonly harnessCli?: HarnessCli;
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Asks one question on the terminal and returns the answer (install's sign-in question). */
  readonly ask?: (question: string) => Promise<string>;
  readonly isTTY?: boolean;
  readonly packageRoot?: string;
  /** Tests only: stands in for the service manager when uninstall or data delete removes the unit. */
  readonly serviceExec?: ServiceExec;
  /** Tests only: stands in for the OS keychain for data delete --scope credential. */
  readonly openKeyring?: OpenHostSecret;
  /** Tests only: the environment install and doctor read PATH and SHELL from for the `jevris` command. */
  readonly env?: { readonly [key: string]: string | undefined };
  /** Tests only: stands in for reg.exe when install or uninstall changes the Windows user PATH. */
  readonly regExec?: RegExec;
  /** Tests only: true when a path is a runnable file (Windows PATH fixtures). */
  readonly isExecutableFile?: (path: string) => boolean;
  /** Tests only: stand in for the running sidecar when install checks its build. */
  readonly sidecarBuild?: SidecarBuildPorts;
}

type Write = (text: string) => void;

export function isAdminCommand(argv: readonly string[]): boolean {
  const first = argv[0];
  if (first === undefined || !ADMIN_COMMANDS.has(first)) return false;
  if (first === 'data') return argv[1] === 'delete';
  return true;
}

/** The home every admin command uses: --home, else JEVRIS_HOME, else the OS home (ADM-01). */
export function resolveHome(flag?: string): { readonly home: string; readonly source: string } {
  return platformResolveHome(typeof flag === 'string' && flag.length > 0 ? { home: flag } : {});
}

const HELP: Readonly<Record<string, string>> = {
  pack: PACK_HELP,
  install: [
    'Usage: jevris install [--harness <name>] [--home <dir>] [--dry-run | --yes] [--no-certify] [--json]',
    '',
    'Installs Jevris into one harness, or into claude, kilo, codex, opencode and antigravity',
    'when --harness is omitted. The runtime is copied to <data>/runtime/<version> and every',
    'harness registration points there, never at the npm cache or a checkout.',
    '',
    'After a successful install it certifies each installed harness, as jevris certify does',
    '(no model call); a harness that does not certify is named with its fix and never fails',
    'the install. On a terminal it then asks once for any sign-in it could not detect.',
    '',
    'It also writes the jevris command: ~/.local/bin/jevris (Windows: %LOCALAPPDATA%\\Jevris\\bin\\',
    'jevris.cmd), which runs the runtime copy with the Node.js that ran install. A jevris there',
    'that is not Jevris\'s own is left alone. When that folder is not on PATH, a terminal is',
    'asked once before a marked block is added to your shell profile (Windows: your user PATH);',
    'otherwise the line to add is printed.',
    '',
    '  --harness <name>  claude | kilo | codex | opencode | antigravity (or agy) (default: all five)',
    '  --dry-run         print every planned change per file; change nothing',
    '  --yes, -y         apply without asking (without a terminal and without --yes, only the plan is printed)',
    '  --no-certify      skip the certification that follows a successful install',
    '  --home <dir>      the home to install into (default: JEVRIS_HOME, else your home)',
    '  --json            print the result as JSON',
    '',
    'Every changed file is backed up first (<data>/backups, the last five kept) and restored if',
    'any step or the post-install smoke check fails. Shared config files keep their other',
    'content byte for byte. A hook acts only where a signed certification record covers that',
    'harness, its version and your OS, and only as far as the mode allows (default',
    'bounded-auto); elsewhere it observes. It makes no permission decision, except that a',
    'certified Codex subagent route answers allow on the spawn_agent call it rewrites. Native',
    'permissions and sandbox stay in force.',
    '',
    'Exit codes: 0 installed, or planned (--dry-run, or no --yes without a terminal); 1 a step',
    'failed and every change was restored; 2 usage error, unknown harness, a refused plan, or',
    'a no at the prompt (in each of these cases nothing was changed).',
    '',
    'Examples:',
    '  jevris install --dry-run',
    '  jevris install --harness codex --yes',
  ].join('\n'),
  uninstall: [
    'Usage: jevris uninstall [--harness <name>] [--home <dir>] [--keep-data | --delete-data] [--dry-run] [--json]',
    '',
    'Removes only what Jevris added, as listed in its install receipt. A Jevris file you',
    'changed after install is reported and left in place. Your other settings are kept byte',
    'for byte. The last harness removed also takes the jevris command, its marked PATH block',
    'and the user PATH entry install added.',
    '',
    '  --harness <name>  remove from one harness only (default: every installed harness)',
    '  --keep-data       keep decisions and receipts in the Jevris data folder (default)',
    '  --delete-data     also delete the Jevris data folder',
    '  --dry-run         print what would be removed; change nothing',
    '  --home <dir>      the home to uninstall from (default: JEVRIS_HOME, else your home)',
    '  --json            print the result as JSON',
    '',
    'Settings are in the Jevris config folder, which uninstall keeps either way;',
    'jevris data delete --scope config removes it.',
    '',
    'Exit codes: 0 removed or planned; 1 a step failed and every change was restored;',
    '2 usage error or a refused plan (nothing was changed).',
    '',
    'Example:',
    '  jevris uninstall --harness kilo --dry-run',
  ].join('\n'),
  doctor: [
    'Usage: jevris doctor [--home <dir>] [--harness <name>] [--workspace <dir>] [--json]',
    '',
    'Per harness: whether Jevris is installed, the harness binary version, how many signed',
    'certification records this machine holds (rejected records are listed with a reason), and',
    'either "certified for <range> (last verified <version>, <date>): <features>" or',
    '"not certified" with the one command that certifies it. A record covers the version range',
    'its harness.json declares, on this operating system; an installed version outside every',
    'range is re-checked once in the background (no model call). A worker line shows owned',
    'workers: "certified, pending first use" until the first owned run checks its start,',
    'then "verified in use (N runs)", or "demoted: <reason>" when a check failed. A parity',
    'line names each feature that harness does not support and why. Also Node, the sidecar,',
    'egress and the workspace verification state. Every problem names a fix. A version number',
    'alone never certifies anything; only a verified record whose range covers it does.',
    '',
    '  --harness <name>   report one harness only',
    '  --workspace <dir>  the workspace to check (default: the current directory)',
    '  --home <dir>       the home to inspect (default: JEVRIS_HOME, else your home)',
    '  --json             print the report as JSON: {report, providerOverride, testWorkerPort,',
    '                     sidecar, harnesses, auth, managedPolicies, settings, certifications,',
    '                     summary, lines, privateFiles}, plus authSettingsProblem and',
    '                     antigravityProducts when they apply',
    '',
    'Exit codes: 0 report printed; 2 usage error.',
  ].join('\n'),
  certify: [
    'Usage: jevris certify --harness <name|all> [--home <dir>] [--evidence <dir>] [--signing-key <pem> --key-id <id>] [--json]',
    '       jevris certify --harness <name|all> --model-signals [--home <dir>] [--json]',
    '',
    'Certifies a harness on this machine. Installs Jevris into a temporary profile, checks',
    'the real harness binary (plugin, MCP tools, skill discovery), runs the conformance cases',
    'through the installed hook, and writes a signed record to',
    '<data>/certifications/<harness>-<os>.json in your Jevris home. Only features that pass',
    'are certified. No model is called. With all, it certifies every harness Jevris is',
    'installed in, one after another.',
    '',
    'It starts the real harness binary. Your own harness profile is never touched. In a test',
    'run it is refused unless JEVRIS_LIVE_HARNESS=1 is set.',
    '',
    'With --model-signals it runs only the found-gone capture, and only when you ask: one',
    'headless turn per harness on your own installed harness, with your own sign-in and',
    'settings, in an empty temporary folder, with no tools, asking for a model id that does',
    'not exist (claude-nonexistent-0, gpt-nonexistent-0, openai/gpt-nonexistent-0 for OpenCode',
    'and Kilo, gemini-nonexistent-0). It prints the exact command before each run and records',
    'which found-gone signal the harness showed, at its version, in',
    '<data>/certifications/model-signals/<harness>.json (the signal and the event\'s key',
    'names, never its text). A harness should refuse an unknown model before any billed work,',
    'but that is not guaranteed. Nothing else runs it.',
    '',
    '  --harness <name>     claude | kilo | codex | opencode | antigravity or agy, or all (required)',
    '  --evidence <dir>     where the two evidence files go (default: <data>/evidence); it must be under the working directory, your home or the temp directory, outside the Jevris folders, and not reached through a link',
    '  --signing-key <pem>  sign with this Ed25519 private key file instead of the local key',
    '  --key-id <id>        the key id to record with --signing-key',
    '  --model-signals      run only the found-gone capture described above (it starts the harness with your sign-in)',
    '  --home <dir>         the home whose data folder receives the record (default: JEVRIS_HOME, else your home)',
    '  --json               print the result as JSON',
    '',
    'Exit codes: 0 certified (with all: every one); 1 not certified (some checks failed, or the',
    'harness is missing); 2 usage error.',
    '',
    'Examples:',
    '  jevris certify --harness all',
    '  jevris certify --harness opencode',
    '  jevris certify --harness claude --model-signals',
  ].join('\n'),
  data: [
    'Usage: jevris data delete [--scope <list>] [--dry-run] [--home <dir>] [--json]',
    '',
    'Deletes the Jevris data folder (ledger, capsules, receipts, runtime copy, backups) and the',
    'kill switch files. The sidecar is stopped first. Harness registrations are not touched; run',
    'jevris uninstall first. While the kill switch is stopped nothing is deleted: run jevris',
    'kill-switch clear first. Local deletion is not deletion by a model vendor or gateway.',
    '',
    'Options:',
    '  --scope <list>  a comma list: ledger (the decision store), capsules (checkpoint capsules),',
    '                  learning (route-learning state), config (the Jevris config folder),',
    '                  credential (the host key in the OS',
    '                  keychain), data (the whole data folder, the default) or all (data, config',
    '                  and credential)',
    '  --dry-run       list what would be deleted and change nothing',
    '  --home <dir>    the home whose data is deleted (default: JEVRIS_HOME, else your home)',
    '  --json          one JSON document',
    '',
    'Exit codes: 0 deleted (or planned with --dry-run); 2 an unknown scope, the kill switch is',
    'stopped (KILL_SWITCH_ACTIVE), the sidecar did not stop (SIDECAR_RUNNING), or something could',
    'not be deleted.',
    '',
    'Examples:',
    '  jevris data delete --dry-run',
    '  jevris data delete --scope ledger,capsules',
    '  jevris data delete --scope all',
  ].join('\n'),
};

export function helpText(command: string): string | null {
  return HELP[command] ?? null;
}

function out(write: Write | undefined, text: string): void {
  if (write !== undefined) write(text);
  else process.stdout.write(text);
}

const VERBS: Readonly<Record<PlannedChange['action'], string>> = {
  create: 'create',
  replace: 'replace',
  edit: 'edit',
  strip: 'remove from',
  delete: 'delete',
  keep: 'keep',
  run: 'run',
  copy: 'copy',
};

export function formatChanges(changes: readonly PlannedChange[]): string[] {
  const lines: string[] = [];
  let current = '';
  for (const change of changes) {
    if (change.harness !== current) {
      current = change.harness;
      lines.push(`${current}:`);
    }
    lines.push(`  ${VERBS[change.action].padEnd(11)} ~/${change.path}${change.detail.length > 0 ? `  (${change.detail})` : ''}`);
  }
  return lines;
}

/** Install's lines after a successful install: certification, sign-in answers (install-setup.ts). */
interface SetupLines {
  readonly certification: readonly string[];
  readonly auth: readonly string[];
  /** The `jevris` command: on PATH, which one runs, or the line to add (command-launcher.ts). */
  readonly command?: readonly string[];
  /** A running sidecar on an older build than the runtime just installed (refreshSidecarBuild). */
  readonly sidecar?: readonly string[];
}

function formatReport(command: string, home: string, report: OperationReport, setup?: SetupLines): string {
  const lines = [`home: ${home}`];
  if (report.runtime !== null) lines.push(`runtime: ${report.runtime.dir} (${report.runtime.version})`);
  if (report.status === 'planned') lines.push(`${command} plan (nothing was changed):`);
  lines.push(...formatChanges(report.changes));
  for (const result of report.smoke) lines.push(`smoke ${result.harness} ${result.check}: ${result.ok ? 'ok' : 'failed'} (${result.detail})`);
  if (report.ok && command === 'install' && report.status === 'installed') {
    if (setup === undefined) lines.push('mode: reduced (observe only until certified: jevris certify --harness all)');
    else lines.push(...setup.certification, ...setup.auth, ...(setup.command ?? []), ...(setup.sidecar ?? []));
  }
  for (const path of report.conflicts) lines.push(`${report.status === 'restored' ? 'not restored (changed meanwhile)' : 'kept'}: ~/${path}`);
  if (report.backup !== null) lines.push(`backup: ${report.backup}`);
  for (const step of report.nextSteps) lines.push(`next: ${step}`);
  if (report.error !== null) lines.push(`error: ${report.error}`);
  lines.push(report.ok ? (report.status === 'planned' ? 'planned' : report.status) : 'refused');
  return `${lines.join('\n')}\n`;
}

function emitReport(write: Write | undefined, command: string, home: string, report: OperationReport, json: boolean, setup?: SetupLines & { readonly results: readonly unknown[] }): number {
  if (json) {
    out(write, `${JSON.stringify({ schemaVersion: '1.0', command, home, ...report, ...(setup === undefined ? {} : { certification: setup.results }), ...(setup?.sidecar === undefined || setup.sidecar.length === 0 ? {} : { sidecar: setup.sidecar }) }, null, 2)}\n`);
  } else {
    out(write, formatReport(command, home, report, setup));
  }
  return report.ok ? COMMAND_EXIT_CODES.ok : report.status === 'restored' ? COMMAND_EXIT_CODES.negative : COMMAND_EXIT_CODES.usage;
}

function usage(write: Write | undefined, command: string, problem: string): number {
  out(write, `${problem}\n\n${HELP[command] ?? ''}\n`);
  return COMMAND_EXIT_CODES.usage;
}

async function askLineOnTerminal(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const onData = (chunk: Uint8Array): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      const Ctor = (globalThis as unknown as { TextDecoder?: new () => { decode(input?: Uint8Array): string } }).TextDecoder;
      resolve(Ctor === undefined ? '' : new Ctor().decode(chunk).split(/\r?\n/)[0] ?? '');
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function askOnTerminal(question: string): Promise<boolean> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const onData = (chunk: Uint8Array): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      const Ctor = (globalThis as unknown as { TextDecoder?: new () => { decode(input?: Uint8Array): string } }).TextDecoder;
      const answer = Ctor === undefined ? '' : new Ctor().decode(chunk);
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

function rootFor(hooks: AdminHooks | undefined): string {
  if (hooks?.packageRoot !== undefined) return hooks.packageRoot;
  const override = process.env.JEVRIS_PACKAGE_ROOT;
  if (process.env.JEVRIS_TEST === '1' && typeof override === 'string' && override.length > 0) return override;
  return packageRoot(import.meta.url);
}

function harnessFlag(value: string | boolean | undefined): GlobalHarness | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  return normalizeHarness(value);
}

export async function runAdminCommand(argv: readonly string[], write?: Write, hooks?: AdminHooks): Promise<number> {
  const command = argv[0] ?? '';
  let values: { readonly [key: string]: string | boolean | undefined };
  let positionals: readonly string[];
  try {
    const parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      strict: true,
      options: {
        home: { type: 'string' },
        harness: { type: 'string' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
        y: { type: 'boolean' },
        json: { type: 'boolean' },
        'keep-data': { type: 'boolean' },
        'delete-data': { type: 'boolean' },
        evidence: { type: 'string' },
        reverify: { type: 'string' },
        help: { type: 'boolean' },
        h: { type: 'boolean' },
        enable: { type: 'boolean' },
        platform: { type: 'string' },
        'harness-version': { type: 'string' },
        'node-version': { type: 'string' },
        'no-smoke': { type: 'boolean' },
        'no-certify': { type: 'boolean' },
        live: { type: 'boolean' },
        workspace: { type: 'string' },
        'signing-key': { type: 'string' },
        'key-id': { type: 'string' },
        report: { type: 'string' },
        metrics: { type: 'string' },
        key: { type: 'string' },
        'kill-switch': { type: 'boolean' },
        cleanup: { type: 'boolean' },
        scope: { type: 'string' },
        'model-signals': { type: 'boolean' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    return usage(write, command, `jevris ${command}: ${String((error as { message?: unknown }).message ?? 'invalid options').slice(0, 200)}`);
  }
  if (values.help === true || values.h === true) {
    out(write, `${HELP[command] ?? ''}\n`);
    return COMMAND_EXIT_CODES.ok;
  }
  const json = values.json === true;
  const resolved = resolveHome(typeof values.home === 'string' ? values.home : undefined);
  const { home } = resolved;
  // ADM-01: the default is the real home, so the test environment must name a temporary one.
  const refusal = testHomeRefusal(resolved);
  if (refusal !== null) {
    process.stderr.write(`jevris ${command}: ${refusal.message}\n`);
    out(write, json ? `${JSON.stringify({ schemaVersion: '1.0', command, ok: false, reasonCode: refusal.reasonCode, message: refusal.message })}\n` : `refused (${refusal.reasonCode}): ${refusal.message}\n`);
    return COMMAND_EXIT_CODES.usage;
  }
  // `jevris certify --harness all` certifies every installed harness in turn.
  const certifyAll = command === 'certify' && values.harness === 'all';
  const harness = certifyAll ? undefined : harnessFlag(values.harness);
  if (harness === null) {
    return usage(write, command, `jevris ${command}: unknown harness ${JSON.stringify(values.harness)}; use one of ${GLOBAL_HARNESSES.join(', ')}`);
  }

  if (command === 'pack') {
    const { runPackCommand } = await import('./pack-cli.js');
    // A person at a terminal: stdin and stdout both TTYs (SR-1), as route limits clear asks.
    const interactive = hooks?.isTTY ?? (process.stdin.isTTY === true && Reflect.get(process.stdout, 'isTTY') === true);
    return runPackCommand(
      { home, json, positionals, values, root: rootFor(hooks), confirm: interactive ? (hooks?.confirm ?? askOnTerminal) : null, ...(hooks?.env === undefined ? {} : { env: hooks.env }) },
      (text) => out(write, text),
    );
  }

  if (command === 'install') {
    if (positionals.length > 0) return usage(write, command, `jevris install: unexpected argument ${JSON.stringify(positionals[0])}`);
    const base = {
      home,
      root: rootFor(hooks),
      ...(harness === undefined ? {} : { harness }),
      ...(hooks?.harnessCli === undefined ? {} : { cli: hooks.harnessCli }),
      ...(hooks?.afterConfigRead === undefined ? {} : { afterConfigRead: hooks.afterConfigRead }),
      ...(values['no-smoke'] === true ? { smoke: false } : {}),
    };
    const { certifiedHooks } = await import('./certification.js');
    const { defaultHarnessCli: harnessCliDefault } = await import('./global-harness.js');
    const certified = certifiedHooks(home, hooks?.harnessCli ?? harnessCliDefault);
    if (values['dry-run'] === true) {
      return emitReport(write, 'install', home, await installGlobal({ ...base, dryRun: true }, certified), json);
    }
    const yes = values.yes === true || values.y === true;
    if (!yes) {
      const plan = await installGlobal({ ...base, dryRun: true }, certified);
      if (!plan.ok) return emitReport(write, 'install', home, plan, json);
      const interactive = hooks?.isTTY ?? process.stdin.isTTY === true;
      if (!interactive || json) {
        const text = json ? '' : formatReport('install', home, plan);
        // Without a terminal the plan is the answer (owner directive): exit 0, nothing changed.
        out(write, `${text}Nothing was changed: this was the plan only. Re-run with --yes to apply it.\n`);
        return COMMAND_EXIT_CODES.ok;
      }
      out(write, formatReport('install', home, plan));
      const confirm = hooks?.confirm ?? askOnTerminal;
      if (!(await confirm('Apply these changes? [y/N] '))) {
        out(write, 'Nothing was changed, so this exits 2.\n');
        return COMMAND_EXIT_CODES.usage;
      }
    }
    const report = await installGlobal(base, certified);
    if (!report.ok || report.status !== 'installed') return emitReport(write, 'install', home, report, json);
    // Owner directive: the setup is automatic. Certify what was installed (no model call); a
    // harness that does not certify never fails the install. Then ask once, on a terminal only,
    // for a sign-in nothing could detect.
    const setup = await import('./install-setup.js');
    const { installedHarnesses, defaultHarnessCli } = await import('./global-harness.js');
    const { jevrisPaths } = await import('@jevris/platform');
    const installedNow = (await installedHarnesses(jevrisPaths({ home }).data)).filter((item) => harness === undefined || item === harness);
    const cli = hooks?.harnessCli ?? defaultHarnessCli;
    const skip = values['no-certify'] === true;
    // G1 (parity audit a38e889): Antigravity's hook group is written disabled until a record
    // certifies its hooks. Whether this install wrote it disabled is read before certify runs.
    const agyWasOff = !skip && installedNow.includes('antigravity') && !(await certified('antigravity'));
    // B's MEDIUM 26 (access limits R68): Claude's StopFailure hook is registered only once a
    // record certifies access.session for the installed binary. Read before certify runs, too.
    const { certifiedClaudeGates } = await import('./global-harness.js');
    const claudeGatesBefore = !skip && installedNow.includes('claude') ? await certifiedClaudeGates(certified) : null;
    const results = skip ? [] : await setup.certifyInstalled({ home, root: rootFor(hooks), harnesses: installedNow, cli });
    // When this run's certify passed, the group is re-rendered enabled in the same run, so the
    // first install does not leave the hooks off until a second one.
    const agyEnabled = agyWasOff && results.some((item) => item.harness === 'antigravity' && item.ok) && (await certified('antigravity'))
      ? (await installGlobal({ ...base, harness: 'antigravity', smoke: false }, certified)).ok
      : null;
    const claudeGatesNow = claudeGatesBefore !== null && results.some((item) => item.harness === 'claude') ? await certifiedClaudeGates(certified) : null;
    const claudeGated = claudeGatesNow !== null && claudeGatesBefore !== null && claudeGatesNow.some((event) => !claudeGatesBefore.includes(event))
      ? { events: claudeGatesNow, ok: (await installGlobal({ ...base, harness: 'claude', smoke: false }, certified)).ok }
      : null;
    const interactive = !json && (hooks?.isTTY ?? process.stdin.isTTY === true);
    const auth = interactive ? await setup.askUnknownAuth({ home, harnesses: installedNow, cli, ask: hooks?.ask ?? askLineOnTerminal }) : [];
    const certification = skip
      ? ['mode: reduced (observe only until certified: jevris certify --harness all)']
      : [
          ...setup.certificationLines(results),
          ...(agyEnabled === null ? [] : [agyEnabled ? 'antigravity hooks: enabled (certified in this run)' : 'antigravity hooks: still off; fix: jevris install --harness antigravity']),
          ...(claudeGated === null ? [] : [claudeGated.ok ? `claude hooks: ${claudeGated.events.join(', ')} registered (certified in this run)` : `claude hooks: ${claudeGated.events.join(', ')} not registered yet; fix: jevris install --harness claude`]),
        ];
    // The `jevris` command: say whether it is on PATH and which one runs; on a terminal, offer
    // once to add its folder to PATH (never silently); otherwise print the line to add.
    const { commandSetup } = await import('./command-launcher.js');
    const { resolve } = await import('node:path');
    const commandLines = json
      ? []
      : await commandSetup({
          place: { home: resolve(home), dataRoot: jevrisPaths({ home: resolve(home) }).data, platform: process.platform, env: hooks?.env ?? process.env },
          interactive,
          confirm: hooks?.confirm ?? askOnTerminal,
          accountHome: resolved.source === 'os',
          ...(hooks?.regExec === undefined ? {} : { regExec: hooks.regExec }),
          ...(hooks?.isExecutableFile === undefined ? {} : { isExecutableFile: hooks.isExecutableFile }),
        });
    // A running sidecar keeps the code it started with: move it onto the build just installed.
    const { refreshSidecarBuild } = await import('./runtime-commands.js');
    const sidecarLine = report.runtime === null ? null : await refreshSidecarBuild({ home, runtimeDir: report.runtime.dir, ...(hooks?.sidecarBuild === undefined ? {} : { ports: hooks.sidecarBuild }) });
    const sidecarLines = sidecarLine === null ? [] : [sidecarLine];
    return emitReport(write, 'install', home, report, json, { certification, auth, results, command: commandLines, sidecar: sidecarLines });
  }

  if (command === 'uninstall') {
    if (values['keep-data'] === true && values['delete-data'] === true) {
      return usage(write, command, 'jevris uninstall: choose --keep-data or --delete-data, not both');
    }
    const report = await uninstallGlobal({
      home,
      ...(harness === undefined ? {} : { harness }),
      ...(values['dry-run'] === true ? { dryRun: true } : {}),
      ...(values['delete-data'] === true ? { deleteData: true } : {}),
      ...(hooks?.harnessCli === undefined ? {} : { cli: hooks.harnessCli }),
      ...(hooks?.afterConfigRead === undefined ? {} : { afterConfigRead: hooks.afterConfigRead }),
      ...(hooks?.serviceExec === undefined ? {} : { serviceExec: hooks.serviceExec }),
      ...(hooks?.regExec === undefined ? {} : { regExec: hooks.regExec }),
    });
    return emitReport(write, 'uninstall', home, report, json);
  }

  if (command === 'data') {
    // DATA-12, IPC-17, GOV-04: scopes, --dry-run, the sidecar first, the kill switch, the vendor line.
    const { runDataDelete } = await import('./data-delete.js');
    return runDataDelete(
      { home, json, values, ...(hooks?.serviceExec === undefined ? {} : { serviceExec: hooks.serviceExec }), ...(hooks?.openKeyring === undefined ? {} : { openKeyring: hooks.openKeyring }) },
      (text) => out(write, text),
      (problem) => usage(write, command, problem),
    );
  }

  if (command === 'doctor') {
    const { runDoctorCommand } = await import('./doctor-cli.js');
    return runDoctorCommand({ home, json, ...(harness === undefined ? {} : { harness }), values, root: rootFor(hooks), ...(hooks?.harnessCli === undefined ? {} : { cli: hooks.harnessCli }), ...(hooks?.env === undefined ? {} : { env: hooks.env }) }, (text) => out(write, text));
  }

  if (command === 'certify') {
    if (harness === undefined && !certifyAll) return usage(write, command, 'jevris certify: --harness is required (a harness name, or all)');
    if (values['model-signals'] === true) {
      const { runModelSignalCapture } = await import('./model-signal-capture.js');
      return runModelSignalCapture({ home, json, ...(harness === undefined ? {} : { harness }), ...(hooks?.harnessCli === undefined ? {} : { cli: hooks.harnessCli }) }, (text) => out(write, text));
    }
    const { runCertifyAllCommand, runCertifyCommand } = await import('./certification.js');
    const certifyOptions = {
      home,
      json,
      root: rootFor(hooks),
      ...(typeof values.evidence === 'string' ? { evidence: values.evidence } : {}),
      ...(typeof values['signing-key'] === 'string' ? { signingKey: values['signing-key'] } : {}),
      ...(typeof values['key-id'] === 'string' ? { keyId: values['key-id'] } : {}),
      ...(hooks?.harnessCli === undefined ? {} : { cli: hooks.harnessCli }),
    };
    if (harness === undefined) return runCertifyAllCommand(certifyOptions, (text) => out(write, text));
    return runCertifyCommand(
      {
        home,
        harness,
        json,
        root: rootFor(hooks),
        ...(typeof values.evidence === 'string' ? { evidence: values.evidence } : {}),
        ...(typeof values['signing-key'] === 'string' ? { signingKey: values['signing-key'] } : {}),
        ...(typeof values['key-id'] === 'string' ? { keyId: values['key-id'] } : {}),
        ...(typeof values.reverify === 'string' ? { reverify: values.reverify } : {}),
        ...(hooks?.harnessCli === undefined ? {} : { cli: hooks.harnessCli }),
      },
      (text) => out(write, text),
    );
  }
  return usage(write, 'install', `jevris: unknown command ${command}`);
}
