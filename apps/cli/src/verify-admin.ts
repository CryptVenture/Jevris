/**
 * `jevris verify profile|approve|revoke|issuer|waive|import-ci`: the verification
 * administration commands (VER-*, CMD-05). They are CLI-only: approval, revocation, waivers
 * and trusted CI issuers change what counts as verified, so no MCP tool or hook reaches them.
 * Changes need a person. A change that widens what counts as verified (approve, issuer add,
 * waive) or lets MCP clients submit owned work (owned-mode on) needs a person at an interactive
 * terminal who answers y, and refuses --yes (SR-1, `personAtTerminal`). A change that only
 * narrows (revoke, issuer remove, owned-mode off) takes a y/N answer or --yes.
 *
 * Approvals, issuers and waivers are D's host-ledger records (`@jevris/orchestrator`). A CI
 * import writes receipts into the store and the required-check report reads them, so both go
 * through the sidecar (`verify.import-ci`, `verify.required`) and have no local path.
 */
import { createPublicKey } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { profileWorkspace, proposeChecks } from '@jevris/languages';
import {
  addTrustedIssuer,
  approveManifests,
  approveProposal,
  openWorkspace,
  ownedModeRecord,
  readProposedManifests,
  setOwnedMode,
  removeTrustedIssuer,
  revokeApproval,
  trustedIssuers,
  waiveCheck,
  workspaceIdFor,
} from '@jevris/orchestrator';
import { createSurfaceContext, type SurfaceContext } from './public/context.js';
import { defaultPorts, type SurfacePorts } from './public/ports.js';
import { homeRefusal } from './public/home-guard.js';

type Write = (text: string) => void;

export const VERIFY_SUBCOMMANDS = ['profile', 'approve', 'revoke', 'issuer', 'waive', 'import-ci', 'required'] as const;

export function isVerifySubcommand(value: string | undefined): boolean {
  return value !== undefined && (VERIFY_SUBCOMMANDS as readonly string[]).includes(value);
}

export interface VerifyAdminOptions {
  readonly ports?: SurfacePorts;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly cwd?: string;
  readonly nowMs?: () => number;
  /** Interactive confirmation; defaults to a y/N question on the terminal when stdin is a TTY. */
  readonly confirm?: ((question: string) => Promise<boolean>) | null;
  /** Whether stdin and stdout are an interactive terminal (default: both are TTYs). */
  readonly interactive?: () => boolean;
  readonly platform?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BUNDLE_CAP = 1_048_576;
const ARTIFACT_TOTAL_CAP = 8 * 1_048_576;
const KEY_CAP = 16_384;

export interface Args {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

export function parse(argv: readonly string[], valueFlags: readonly string[], boolFlags: readonly string[]): Args | string {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (boolFlags.includes(name)) {
      if (eq !== -1) return `${name} takes no value.`;
      flags.add(name);
      continue;
    }
    if (!valueFlags.includes(name)) return `Unknown option ${name.slice(0, 40)}.`;
    const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
    if (value === undefined || value.length === 0) return `${name} needs a value.`;
    if (values.has(name)) return `${name} was given twice.`;
    if (eq === -1) i += 1;
    values.set(name, value);
  }
  return { positionals, values, flags };
}

export async function askOnTerminal(question: string): Promise<boolean> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const onData = (chunk: Uint8Array): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(/^\s*y(es)?\s*$/i.test(new TextDecoder().decode(chunk)));
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

/** stdin and stdout are both terminals: the only channel a person-only change is taken from. */
export function stdioIsTerminal(): boolean {
  return process.stdin.isTTY === true && Reflect.get(process.stdout, 'isTTY') === true;
}

/** How a person-only change arrived: the flags that refuse it, the environment, and the terminal. */
export interface TerminalChannel {
  readonly yes: boolean;
  readonly json: boolean;
  readonly env: { readonly [key: string]: string | undefined };
  readonly interactive?: (() => boolean) | undefined;
  readonly confirm?: ((question: string) => Promise<boolean>) | null | undefined;
}

/**
 * SR-1: a change to what counts as verified, who is trusted or what may leave the machine needs a
 * person at an interactive terminal who answers y, as `route limits clear`, `egress approve` and
 * the session link do. --yes, --json, a pipe, a script, MCP, a hook and a test run
 * (JEVRIS_TEST=1) are refused with CHANNEL_REFUSED before anything is asked, in one plain line.
 * A same-user process that fakes a terminal is the documented limit (docs/security.md).
 */
export async function personAtTerminal(channel: TerminalChannel, question: string, write: Write, what: string): Promise<boolean> {
  const interactive = channel.interactive ?? stdioIsTerminal;
  if (channel.yes || channel.json || channel.env['JEVRIS_TEST'] === '1' || !interactive()) {
    write(`Nothing was changed (CHANNEL_REFUSED): ${what}, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).\n`);
    return false;
  }
  const confirm = channel.confirm ?? askOnTerminal;
  return confirm(question);
}

/**
 * Human authorization for a change: --yes, or a y/N answer on an interactive terminal. `what`
 * names the effect in the refusal line. With `terminalOnly` the change needs a person at a
 * terminal and --yes is refused (`personAtTerminal`, SR-1).
 */
export async function authorized(args: Args, options: VerifyAdminOptions, question: string, write: Write, json: boolean, what = 'This changes what counts as verified', terminalOnly = false): Promise<boolean> {
  if (terminalOnly) {
    const channel: TerminalChannel = { yes: args.flags.has('--yes'), json, env: options.env ?? process.env, interactive: options.interactive, confirm: options.confirm };
    return personAtTerminal(channel, question, write, `${what.charAt(0).toLowerCase()}${what.slice(1)}`);
  }
  if (args.flags.has('--yes')) return true;
  const confirm = options.confirm !== undefined ? options.confirm : process.stdin.isTTY === true ? askOnTerminal : null;
  if (confirm === null || json) {
    write(`Nothing was changed. ${what}, so run it in a terminal to confirm, or add --yes.\n`);
    return false;
  }
  return confirm(question);
}

export function contextFor(args: Args, options: VerifyAdminOptions, ports: SurfacePorts): SurfaceContext {
  return createSurfaceContext({
    home: args.values.get('--home'),
    workspace: args.values.get('--workspace'),
    scope: 'cli',
    ports,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
}

function done(write: Write, json: boolean, command: string, result: object, text: string, code: number): number {
  const name = command === 'owned-mode' ? 'configure owned-mode' : `verify ${command}`;
  write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: name, ...result })}\n` : text.endsWith('\n') ? text : `${text}\n`);
  return code;
}

/** Runs `jevris verify <subcommand> ...` (argv starts after `verify`). */
export async function runVerifyAdmin(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  const sub = argv[0] ?? '';
  const common = ['--home', '--workspace'];
  const specs: { readonly [key: string]: { readonly value: readonly string[]; readonly bool: readonly string[] } } = {
    profile: { value: common, bool: ['--json'] },
    approve: { value: common, bool: ['--json', '--proposal', '--yes'] },
    revoke: { value: common, bool: ['--json', '--yes'] },
    issuer: { value: [...common, '--key', '--key-id', '--repository'], bool: ['--json', '--yes'] },
    waive: { value: [...common, '--reason', '--authority', '--by'], bool: ['--json', '--yes'] },
    'import-ci': { value: [...common, '--artifacts'], bool: ['--json'] },
    required: { value: common, bool: ['--json'] },
  };
  const spec = specs[sub];
  if (spec === undefined) {
    write(`Unknown verify subcommand. Run jevris help verify.\n`);
    return COMMAND_EXIT_CODES.usage;
  }
  const parsed = parse(argv.slice(1), spec.value, spec.bool);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help verify for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const ports = options.ports ?? (await defaultPorts());
  const ctx = contextFor(parsed, options, ports);
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  const root = ctx.workspaceRoot;
  if (root === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const platform = options.platform ?? process.platform;
  const pos = parsed.positionals;
  const ws = () => openWorkspace({ home: ctx.home, workspaceRoot: root, platform });

  switch (sub) {
    case 'profile': {
      if (pos.length > 0) return usage('verify profile takes no arguments.');
      const proposal = proposeChecks(profileWorkspace(root), root, platform);
      const ids = proposal.checks.map((check) => check.id);
      // W12: say what was detected, and that what no certified analyzer covers is unverified.
      const detected = (proposal.detected ?? []).map(describeMetadata);
      const unverified = (proposal.unverified ?? []).map(describeMetadata);
      const text =
        ids.length === 0
          ? detected.length === 0
            ? 'No checks could be proposed for this workspace. Write jevris.checks.json by hand.'
            : `Detected: ${detected.join(', ')}. No certified analyzer understands them, so build and test semantics are unverified. Write jevris.checks.json by hand.`
          : [
              'Proposed checks (nothing was written):',
              ...ids.map((id) => `  ${id}`),
              ...(unverified.length === 0 ? [] : ['Also detected, with build and test semantics unverified (no certified analyzer understands them):', ...unverified.map((item) => `  ${item}`)]),
              'Approve them with: jevris verify approve --proposal',
            ].join('\n');
      return done(write, json, 'profile', { proposal }, text, ids.length === 0 ? COMMAND_EXIT_CODES.negative : COMMAND_EXIT_CODES.ok);
    }
    case 'approve': {
      if (pos.length > 0) return usage('verify approve takes no arguments.');
      if (parsed.flags.has('--proposal')) {
        const proposal = proposeChecks(profileWorkspace(root), root, platform);
        if (proposal.checks.length === 0) return done(write, json, 'approve', { approved: [], reasonCode: 'NO_PROPOSAL' }, 'No checks could be proposed for this workspace; nothing was approved.', COMMAND_EXIT_CODES.negative);
        const ids = proposal.checks.map((check) => check.id);
        if (!(await authorized(parsed, options, `Approve ${ids.length} proposed check(s): ${ids.join(', ')}? [y/N] `, write, json, undefined, true))) return COMMAND_EXIT_CODES.usage;
        const record = await approveProposal(ws(), proposal, 'cli', platform);
        if ('ok' in record && record.ok === false) return done(write, json, 'approve', { approved: [], reasonCode: 'INVALID_PROPOSAL', reason: record.reason }, `The proposal is not valid (${record.reason}); nothing was approved.`, COMMAND_EXIT_CODES.negative);
        const approved = Object.keys((record as { readonly hashes: object }).hashes).sort();
        return done(write, json, 'approve', { approved, reasonCode: 'APPROVED' }, `Approved: ${approved.join(', ')}`, COMMAND_EXIT_CODES.ok);
      }
      const proposed = readProposedManifests(root, platform);
      if (!proposed.ok) {
        const hint = proposed.reason === 'absent' ? 'No jevris.checks.json here. See proposed checks with jevris verify profile.' : `jevris.checks.json is not valid (${proposed.reason}).`;
        return done(write, json, 'approve', { approved: [], reasonCode: 'NO_MANIFEST', reason: proposed.reason }, `${hint} Nothing was approved.`, COMMAND_EXIT_CODES.negative);
      }
      const ids = proposed.manifests.map((manifest) => manifest.id);
      if (!(await authorized(parsed, options, `Approve ${ids.length} check(s) from ${proposed.file}: ${ids.join(', ')}? [y/N] `, write, json, undefined, true))) return COMMAND_EXIT_CODES.usage;
      const record = await approveManifests(ws(), proposed.manifests, proposed.hashes, 'cli', ctx.nowMs());
      const approved = Object.keys(record.hashes).sort();
      return done(write, json, 'approve', { approved, reasonCode: 'APPROVED' }, `Approved: ${approved.join(', ')}`, COMMAND_EXIT_CODES.ok);
    }
    case 'revoke': {
      for (const id of pos) if (!ID.test(id)) return usage(`Not a check id: ${id.slice(0, 40)}`);
      const what = pos.length === 0 ? 'every approved check' : pos.join(', ');
      if (!(await authorized(parsed, options, `Revoke approval of ${what}? [y/N] `, write, json))) return COMMAND_EXIT_CODES.usage;
      const removed = await revokeApproval(ws(), pos);
      return done(write, json, 'revoke', { revoked: removed }, `Revoked ${removed} approval(s). Verification of those checks is unsupported until they are approved again.`, removed > 0 ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
    }
    case 'issuer': {
      const action = pos[0];
      if (action === 'list') {
        if (pos.length !== 1) return usage('verify issuer list takes no arguments.');
        const issuers = trustedIssuers(ws()).map((issuer) => ({ issuerId: issuer.issuerId, repository: issuer.repository, keyIds: Object.keys(issuer.keys).sort(), addedAt: issuer.addedAt }));
        const text = issuers.length === 0 ? 'No trusted CI issuers.' : issuers.map((i) => `${i.issuerId}${i.repository === null ? '' : ` (${i.repository})`} keys: ${i.keyIds.join(', ')}`).join('\n');
        return done(write, json, 'issuer list', { issuers }, text, COMMAND_EXIT_CODES.ok);
      }
      const issuerId = pos[1];
      if ((action !== 'add' && action !== 'remove') || pos.length !== 2 || issuerId === undefined || !ID.test(issuerId)) {
        return usage('Use jevris verify issuer add <issuer-id> --key <public-key.pem>, issuer remove <issuer-id>, or issuer list.');
      }
      if (action === 'remove') {
        if (!(await authorized(parsed, options, `Stop trusting CI issuer ${issuerId}? [y/N] `, write, json))) return COMMAND_EXIT_CODES.usage;
        await removeTrustedIssuer(ws(), issuerId);
        return done(write, json, 'issuer remove', { issuerId }, `CI issuer ${issuerId} is no longer trusted.`, COMMAND_EXIT_CODES.ok);
      }
      const keyPath = parsed.values.get('--key');
      if (keyPath === undefined) return usage('verify issuer add needs --key <public-key.pem>.');
      const keyId = parsed.values.get('--key-id') ?? 'default';
      if (!ID.test(keyId)) return usage('--key-id must be letters, digits, dot, dash or underscore.');
      const repository = parsed.values.get('--repository') ?? null;
      if (repository !== null && !REPOSITORY.test(repository)) return usage('--repository must be <owner>/<name>.');
      let pem: string;
      try {
        if ((await stat(keyPath)).size > KEY_CAP) return usage('The key file is too large to be a public key.');
        pem = await readFile(keyPath, 'utf8');
      } catch {
        return usage(`Cannot read the key file ${keyPath.slice(0, 200)}.`);
      }
      let type: string | undefined;
      try {
        type = createPublicKey(pem).asymmetricKeyType;
      } catch {
        type = undefined;
      }
      if (type !== 'ed25519' || !pem.includes('BEGIN PUBLIC KEY')) return usage('The key must be an Ed25519 public key in PEM (SPKI) form, not a private key.');
      if (!(await authorized(parsed, options, `Trust CI receipts signed by ${issuerId} (key ${keyId}${repository === null ? '' : `, ${repository} only`})? [y/N] `, write, json, 'Trusting a CI issuer lets its signed receipts count as passed', true))) return COMMAND_EXIT_CODES.usage;
      await addTrustedIssuer(ws(), { issuerId, keys: { [keyId]: pem }, repository }, ctx.nowMs());
      return done(write, json, 'issuer add', { issuerId, keyId, repository }, `CI issuer ${issuerId} is trusted${repository === null ? '' : ` for ${repository}`}.`, COMMAND_EXIT_CODES.ok);
    }
    case 'waive': {
      const checkId = pos[0];
      if (pos.length !== 1 || checkId === undefined || !ID.test(checkId)) return usage('Use jevris verify waive <check-id> --reason "<text>" [--authority <name>].');
      if (parsed.values.has('--authority') && parsed.values.has('--by')) return usage('Give --authority or --by, not both.');
      const reason = parsed.values.get('--reason');
      if (reason === undefined || reason.trim().length === 0) return usage('verify waive needs --reason "<why this check is waived>".');
      let by = parsed.values.get('--authority') ?? parsed.values.get('--by');
      if (by === undefined) {
        try {
          by = userInfo().username;
        } catch {
          return usage('Name the person waiving the check with --authority <name>.');
        }
      }
      if (!(await authorized(parsed, options, `Waive ${checkId} on the authority of ${by}? A waiver is never a pass. [y/N] `, write, json, 'A waiver lets the required-check report complete without the check', true))) return COMMAND_EXIT_CODES.usage;
      const waiver = await waiveCheck(ws(), checkId, by, reason, ctx.nowMs());
      return done(write, json, 'waive', { waiver }, `${checkId} is waived by ${waiver.authority}. A waiver is recorded as waived, never as passed.`, COMMAND_EXIT_CODES.ok);
    }
    case 'required': {
      for (const id of pos) if (!ID.test(id)) return usage(`Not a check id: ${id.slice(0, 40)}`);
      if (pos.length === 0) return usage('Use jevris verify required <check-id>...');
      // A repeated id is asked for once; the report keeps the first-seen command-line order.
      const ids = [...new Set(pos)];
      if (ids.length > 256) return usage('Name at most 256 check ids.');
      const report = await requiredFromSidecar(ctx, ids);
      if (!report.ok) {
        return done(write, json, 'required', { checks: [], reasonCode: report.reasonCode }, `The required-check report is not available (${report.reasonCode}). Receipts live in the Jevris store: start the sidecar with jevris sidecar start and retry.`, COMMAND_EXIT_CODES.negative);
      }
      const lines = report.checks;
      const text = lines.map((line) => `${line.checkId}: ${line.status}${line.stale ? ' (its receipt is stale: run it again)' : ''}${line.waiverAuthority === null ? '' : ` (waived by ${line.waiverAuthority})`}${line.issuer === null ? '' : ` [${line.issuer}]`}`).join('\n');
      const complete = lines.every((line) => line.status === 'passed' || line.status === 'waived');
      return done(write, json, 'required', { checks: lines }, text, complete ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
    }
    case 'import-ci':
      return importCi(parsed, ctx, write, json, usage);
  }
  return usage('Unknown verify subcommand.');
}

 const METADATA_NAMES: { readonly [id: string]: string } = {
  'keil-uvision': 'Keil µVision',
  'iar-embedded-workbench': 'IAR Embedded Workbench',
  'mplab-x': 'MPLAB X',
  stm32cube: 'STM32CubeMX',
  'eclipse-cdt': 'Eclipse CDT',
  make: 'Make',
  meson: 'Meson',
  bazel: 'Bazel',
  scons: 'SCons',
  xcode: 'Xcode',
  'visual-studio': 'Visual Studio',
  arduino: 'Arduino',
  zephyr: 'Zephyr',
  gemfile: 'Bundler',
  composer: 'Composer',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  vhdl: 'VHDL',
  verilog: 'Verilog',
  systemverilog: 'SystemVerilog',
  php: 'PHP',
};

/** "Keil µVision project (firmware.uvprojx)" or "C (2 files)". */
export function describeMetadata(item: { readonly kind: string; readonly id: string; readonly evidence: string; readonly count: number }): string {
  const known = Object.hasOwn(METADATA_NAMES, item.id) ? METADATA_NAMES[item.id] : undefined;
  const name = known ?? (item.id.length > 0 ? `${item.id.charAt(0).toUpperCase()}${item.id.slice(1)}` : 'Unknown');
  if (item.kind === 'project') return `${name} project (${item.evidence.slice(0, 200)})`;
  return `${name} (${item.count} file${item.count === 1 ? '' : 's'})`;
}

/** `stale`: the check has no current receipt because an earlier one went stale (US17); an older sidecar omits it (false). */
type RequiredLine = { readonly checkId: string; readonly status: 'passed' | 'failed' | 'missing' | 'waived'; readonly receiptId: string | null; readonly issuer: string | null; readonly waiverAuthority: string | null; readonly stale: boolean };

const REQUIRED_STATUSES = new Set(['passed', 'failed', 'missing', 'waived']);
const shortOrNull = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length <= 200);

/**
 * The required-check report comes from D's `verify.required` op: receipts live in the store,
 * which only the sidecar opens, so there is no local report. Each line is checked before use.
 */
async function requiredFromSidecar(ctx: SurfaceContext, checkIds: readonly string[]): Promise<{ readonly ok: true; readonly checks: readonly RequiredLine[] } | { readonly ok: false; readonly reasonCode: string }> {
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: ctx.sidecarWaitMs });
    if (!ensured.ok) return { ok: false, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}` };
  }
  const answer = await ctx.ports.sidecar.request({
    home: ctx.home,
    op: 'verify.required',
    workspace: ctx.workspaceRoot ?? ctx.workspaceId,
    body: { checkIds: [...checkIds] },
    scope: 'cli',
    timeoutMs: ctx.requestTimeoutMs,
    budget: 'hot',
  });
  if (!answer.ok) return { ok: false, reasonCode: answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}` };
  // The op answers one line per distinct id in its own order (D sorts them). Lines are matched
  // by checkId: exactly the requested set, each once; the output keeps the command-line order.
  const raw = (answer.result as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(raw) || raw.length !== checkIds.length) return { ok: false, reasonCode: 'SIDECAR_INVALID_RESULT' };
  const byId = new Map<string, RequiredLine>();
  for (const item of raw) {
    const line = item as { checkId?: unknown; status?: unknown; receiptId?: unknown; issuer?: unknown; waiverAuthority?: unknown; stale?: unknown } | null;
    if (line === null || typeof line !== 'object' || typeof line.checkId !== 'string' || !checkIds.includes(line.checkId) || byId.has(line.checkId)) {
      return { ok: false, reasonCode: 'SIDECAR_INVALID_RESULT' };
    }
    if (typeof line.status !== 'string' || !REQUIRED_STATUSES.has(line.status)) return { ok: false, reasonCode: 'SIDECAR_INVALID_RESULT' };
    if (!shortOrNull(line.receiptId) || !shortOrNull(line.issuer) || !shortOrNull(line.waiverAuthority)) return { ok: false, reasonCode: 'SIDECAR_INVALID_RESULT' };
    if (line.stale !== undefined && typeof line.stale !== 'boolean') return { ok: false, reasonCode: 'SIDECAR_INVALID_RESULT' };
    byId.set(line.checkId, { checkId: line.checkId, status: line.status as RequiredLine['status'], receiptId: line.receiptId, issuer: line.issuer, waiverAuthority: line.waiverAuthority, stale: line.stale === true });
  }
  const checks = checkIds.map((id) => byId.get(id) as RequiredLine);
  return { ok: true, checks };
}

/**
 * `jevris configure owned-mode [on|off] [--workspace <dir>] [--json]` (TOOL-10, IPC-10):
 * lets MCP clients of this workspace submit owned work (task.submit only). Turning it on needs
 * a person at an interactive terminal and refuses --yes (SR-1); turning it off never needs a
 * person. No environment variable changes it.
 */
export async function runOwnedMode(argv: readonly string[], write: Write, options: VerifyAdminOptions = {}): Promise<number> {
  const parsed = parse(argv.slice(1), ['--home', '--workspace'], ['--json', '--yes']);
  const json = typeof parsed !== 'string' && parsed.flags.has('--json');
  const usage = (message: string): number => {
    write(json ? `${JSON.stringify({ error: { code: 'USAGE', message } })}\n` : `${message}\nRun jevris help configure for usage.\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (typeof parsed === 'string') return usage(parsed);
  const action = parsed.positionals[0];
  if (parsed.positionals.length > 1 || (action !== undefined && action !== 'on' && action !== 'off')) return usage('Use jevris configure owned-mode [on|off].');
  const ctx = contextFor(parsed, options, options.ports ?? (await defaultPorts()));
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return usage(refusedHome);
  if (ctx.workspaceRoot === null) return usage('No workspace here. Run this inside a repository or pass --workspace <dir>.');
  const workspaceId = workspaceIdFor(ctx.workspaceRoot, options.platform ?? process.platform);
  const answer = (enabled: boolean, changed: boolean): number => {
    const text = `Owned mode is ${enabled ? 'on' : 'off'} for ${ctx.workspaceRoot}${changed ? '' : ' (unchanged)'}. ${
      enabled ? 'MCP clients of this workspace may submit owned work (task.submit only).' : 'MCP clients cannot submit work.'
    }`;
    return done(write, json, 'owned-mode', { workspaceId, enabled }, text, COMMAND_EXIT_CODES.ok);
  };
  const current = ownedModeRecord(ctx.home, workspaceId)?.enabled === true;
  if (action === undefined) return answer(current, false);
  const enabled = action === 'on';
  if (enabled && !current && !(await authorized(parsed, options, `Let MCP clients of ${ctx.workspaceRoot} submit owned work? [y/N] `, write, json, 'Owned mode lets MCP clients start owned work that spends money and runs worker models on this workspace', true))) return COMMAND_EXIT_CODES.usage;
  let actor = 'cli';
  try {
    actor = userInfo().username;
  } catch {
    actor = 'cli';
  }
  const set = await setOwnedMode({ home: ctx.home, workspaceId, enabled, channel: 'cli', actor, nowMs: ctx.nowMs() });
  if (!set.ok) return usage(`Owned mode was not changed (${set.reasonCode}).`);
  return answer(enabled, enabled !== current);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (RFC 4648) without a Buffer dependency. */
export function base64Of(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] ?? '';
    out += B64[(n >> 12) & 63] ?? '';
    out += i + 1 < bytes.length ? (B64[(n >> 6) & 63] ?? '') : '=';
    out += i + 2 < bytes.length ? (B64[n & 63] ?? '') : '=';
  }
  return out;
}

/** A bundle-relative artifact name as the sidecar accepts it: [A-Za-z0-9._/-], no '..' segment. */
export function safeArtifactName(name: unknown): name is string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(name)) return false;
  // A leading slash or '//' gives an empty segment; '..' climbs out of the artifacts folder.
  return !name.split('/').some((segment) => segment === '' || segment === '..');
}

const MAX_ARTIFACTS = 256;

async function importCi(parsed: Args, ctx: SurfaceContext, write: Write, json: boolean, usage: (message: string) => number): Promise<number> {
  const bundlePath = parsed.positionals[0];
  const dir = parsed.values.get('--artifacts');
  if (parsed.positionals.length !== 1 || bundlePath === undefined || dir === undefined) return usage('Use jevris verify import-ci <bundle.json> --artifacts <dir>.');
  let bundle: unknown;
  try {
    if ((await stat(bundlePath)).size > BUNDLE_CAP) return usage('The bundle is larger than 1 MiB.');
    bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as unknown;
  } catch {
    return usage(`Cannot read ${bundlePath.slice(0, 200)} as JSON.`);
  }
  const checks = bundle !== null && typeof bundle === 'object' && Array.isArray((bundle as { checks?: unknown }).checks) ? ((bundle as { checks: unknown[] }).checks) : null;
  if (checks === null) return usage('The bundle has no checks list.');
  const names = new Set<string>();
  for (const check of checks) {
    const artifact = check !== null && typeof check === 'object' ? (check as { artifact?: { name?: unknown } }).artifact : undefined;
    if (artifact === undefined || artifact === null) continue;
    if (!safeArtifactName(artifact.name)) return usage('An artifact name in the bundle is not a plain relative path.');
    names.add(artifact.name);
  }
  if (names.size > MAX_ARTIFACTS) return usage(`The bundle names more than ${MAX_ARTIFACTS} artifacts.`);
  const artifacts: { name: string; base64: string }[] = [];
  let total = 0;
  for (const name of [...names].sort()) {
    const full = join(dir, name);
    const back = relative(dir, full);
    if (back.startsWith('..') || isAbsolute(back)) return usage('An artifact name escapes the artifacts directory.');
    let bytes: Uint8Array;
    try {
      bytes = await readFile(full);
    } catch {
      continue; // The sidecar reports ARTIFACT_UNAVAILABLE for the checks that need it.
    }
    total += bytes.byteLength;
    if (total > ARTIFACT_TOTAL_CAP) return usage('The artifacts are larger than 8 MiB in total.');
    artifacts.push({ name, base64: base64Of(bytes) });
  }
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: 5000 });
    if (!ensured.ok) return done(write, json, 'import-ci', { accepted: false, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}` }, 'The Jevris sidecar is not running, so nothing was imported. Start it with jevris sidecar start and retry.', COMMAND_EXIT_CODES.negative);
  }
  const answer = await ctx.ports.sidecar.request({
    home: ctx.home,
    op: 'verify.import-ci',
    workspace: ctx.workspaceRoot ?? ctx.workspaceId,
    body: { bundle, artifacts },
    scope: 'cli',
    timeoutMs: 30_000,
    budget: 'background',
  });
  if (!answer.ok) {
    const code = answer.reasonCode ?? `SIDECAR_${answer.reason.toUpperCase()}`;
    return done(write, json, 'import-ci', { accepted: false, reasonCode: code }, `Nothing was imported (${code}). ${answer.reason === 'unavailable' ? 'Start the sidecar with jevris sidecar start and retry.' : ''}`.trim(), COMMAND_EXIT_CODES.negative);
  }
  const result = answer.result as { accepted?: unknown; reasonCode?: unknown; binding?: unknown; receiptIds?: unknown };
  const accepted = result.accepted === true;
  const receiptIds = Array.isArray(result.receiptIds) ? result.receiptIds.filter((id): id is string => typeof id === 'string').slice(0, 256) : [];
  const reasonCode = typeof result.reasonCode === 'string' ? result.reasonCode : 'UNKNOWN';
  const binding = result.binding === 'current' || result.binding === 'historical' ? result.binding : null;
  const text = accepted
    ? `Imported ${receiptIds.length} CI receipt(s) (${binding ?? 'unbound'} revision): ${receiptIds.join(', ')}`
    : `The CI bundle was refused (${reasonCode}); nothing was imported.`;
  return done(write, json, 'import-ci', { accepted, reasonCode, binding, receiptIds }, text, accepted ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
}
