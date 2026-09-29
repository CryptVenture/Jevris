/**
 * `jevris egress status | approve | revoke` (GOV-01, §16.4): the one supported way to see and
 * change whether Jevris may send decision fields to Jev, without hand-editing host.json.
 *
 * - The decision is the transport guard's own (B's resolveSourceEgress): the same function that
 *   looks at every Jev request, so status can never disagree with what is sent.
 * - approve widens what leaves the machine, so it needs a person: an interactive terminal (never
 *   MCP, a hook, a pipe or a test run) and a typed phrase, after the exact scope is shown. A
 *   managed policy or an organization.json that denies egress wins; approve then refuses and
 *   says why. It creates host.json with the defaults below when it is missing, and changes only
 *   `egress` when it exists. The write is atomic and owner-only (0600).
 * - revoke only tightens, so it needs no terminal and no phrase.
 * - Both changes are recorded in the audit log (egress.enable, egress.revoke), content-free.
 *
 * No `jevris authorize` token is taken: the terminal and the phrase are the same bar authorize
 * sets, so a separate token would add a step and no assurance.
 */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_REQUEST_BYTES, PINNED_MODEL, copyHostDocument, hasRawKeyProperty, type HostDocument, type HostEgress } from '@jevris/contracts';
import { authorityFileRefusal, insideGitWorkTree, jevrisPaths, resolveHome, writePrivateFile, type AuthorityFileRefusal } from '@jevris/platform';
import { credentialStatus, openHostEntry, type OpenHostSecret } from './credential.js';
import { readManagedPolicy } from './enterprise-policy.js';
import { testHomeRefusal } from './home-guard.js';
import { resolveHostSourceEgress, type HostEgressDecision } from './host-policy.js';
import { recordCliAudit } from './runtime-commands.js';

type Write = (text: string) => void;
type Env = { readonly [key: string]: string | undefined };

export const EGRESS_APPROVE_PHRASE = 'approve egress';

export const EGRESS_HELP = `Usage: jevris egress status [--home <dir>] [--json]
       jevris egress approve [--home <dir>]
       jevris egress revoke [--home <dir>] [--json]

Whether Jevris may send decision fields to Jev (TypeSafe System One). Egress is denied until
you approve it: until then a request to Jev carries only bounded structured features
(categories, counts, reason codes, sizes and salted hashes), never free text from the
workspace or its tools. Your coding harness talks to its own model vendor either way.

status   The effective setting and where it comes from (a managed policy, host.json, or the
         default), what may be sent (field classes, the request byte cap, local retention), and
         whether the Jev key is in the OS keychain (never the key itself).
approve  Shows exactly what approval allows, then asks you to type "${EGRESS_APPROVE_PHRASE}".
         Only from an interactive terminal: never from MCP, a hook, a script or a test run.
         Writes host.json (owner-only) with egress approved-scoped: a missing file is created
         with the defaults, an existing one keeps every other field. A managed policy or an
         organization.json that denies egress wins, and approve then refuses and says why.
revoke   Sets egress back to deny-until-approved. Tightening is always allowed: no terminal
         is needed.

Both changes are recorded in the audit log (jevris audit export).

Options:
  --home <dir>   Jevris home (default: JEVRIS_HOME, else your home directory)
  --json         status and revoke: print one JSON result line

Exit codes: 0 shown or changed (or already so); 1 refused by policy (a managed policy or
organization.json denies, or host.json is invalid); 2 usage error, not an interactive
terminal, or the phrase did not match.

Examples:
  jevris egress status
  jevris egress approve
  jevris egress revoke`;

/** The host.json approve or revoke creates when none exists: the documented defaults. */
export function defaultHostDocument(egress: HostEgress): HostDocument {
  return {
    schemaVersion: '1.0',
    // The most Jevris may do on this host: no ceiling beyond your own settings, as with no file.
    mode: 'bounded-auto',
    egress,
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: MAX_REQUEST_BYTES },
    pin: { model: PINNED_MODEL, respectHumanPins: true },
    packPrivileges: [],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
  };
}

export interface EgressCommandOptions {
  readonly env?: Env;
  /** Whether stdin and stdout are an interactive terminal (default: both are TTYs). */
  readonly interactive?: () => boolean;
  /** Reads one typed line after writing the prompt (default: stdin). */
  readonly readLine?: (prompt: string) => Promise<string | null>;
  readonly openKeyring?: OpenHostSecret;
  /** The transport guard's decision (default: B's resolveSourceEgress from @jevris/sidecar). */
  readonly resolveEgress?: (home: string) => Promise<HostEgressDecision>;
}

type Layer =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly document: HostDocument; readonly raw: Record<string, unknown> };

const MAX_POLICY_BYTES = 262_144;

async function readLayer(path: string): Promise<Layer> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return { kind: 'missing' };
  }
  if (!st.isFile() || st.size > MAX_POLICY_BYTES) return { kind: 'invalid' };
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || hasRawKeyProperty(parsed)) return { kind: 'invalid' };
    const document = copyHostDocument(parsed);
    return document === undefined ? { kind: 'invalid' } : { kind: 'ok', document, raw: parsed as Record<string, unknown> };
  } catch {
    return { kind: 'invalid' };
  }
}

type Denial = 'EGRESS_NOT_APPROVED' | 'MANAGED_POLICY_DENIES' | 'MANAGED_POLICY_REFUSED' | 'ORGANIZATION_DENIES' | 'HOST_POLICY_INVALID' | AuthorityFileRefusal;

interface EgressView {
  readonly egress: 'approved' | 'not-approved';
  readonly setting: HostEgress;
  readonly source: { readonly kind: 'managed' | 'host' | 'default'; readonly path: string | null; readonly narrowedBy: readonly string[] };
  readonly reasonCode: Denial | null;
  readonly maySend: {
    readonly fieldClasses: readonly string[];
    readonly maxRequestBytes: number;
    readonly retention: { readonly rawArtifactRetentionDays: number; readonly decisionRetentionDays: number };
  };
  readonly hostFile: string;
  readonly host: Layer;
  readonly organization: Layer;
  readonly managed: ReturnType<typeof readManagedPolicy>;
}

const STRUCTURED_ONLY = ['categories', 'counts', 'reason codes', 'sizes', 'salted hashes'] as const;
const APPROVED_FIELDS = [...STRUCTURED_ONLY, 'redacted decision text (failure text, tool output, file excerpts, diffs), secret-screened'] as const;

async function view(home: string, resolveEgress: (home: string) => Promise<HostEgressDecision>): Promise<EgressView> {
  const config = jevrisPaths({ home }).config;
  const hostFile = join(config, 'host.json');
  const managed = readManagedPolicy();
  const host = await readLayer(hostFile);
  const organization = await readLayer(join(config, 'organization.json'));
  const egress = await resolveEgress(home);
  // SR-4: a host.json or organization.json that breaks the authority-file rules approves nothing;
  // the same rules the transport guard applies, from @jevris/platform.
  const trustHome = resolveHome({ home }).home;
  const untrusted: AuthorityFileRefusal | null = insideGitWorkTree(trustHome)
    ? 'JEVRIS_HOME_IN_WORK_TREE'
    : ([hostFile, join(config, 'organization.json')].map((file) => authorityFileRefusal(file, { home: trustHome })).find((code) => code !== null) ?? null);
  const docs: HostDocument[] = [];
  if (managed.state === 'ok') docs.push(managed.document);
  if (host.kind === 'ok') docs.push(host.document);
  if (organization.kind === 'ok') docs.push(organization.document);
  const narrowedBy: string[] = [];
  let reasonCode: Denial | null = null;
  let source: EgressView['source'];
  if (managed.state === 'refused') {
    source = { kind: 'managed', path: managed.path, narrowedBy };
    reasonCode = 'MANAGED_POLICY_REFUSED';
  } else if (managed.state === 'ok') {
    if (host.kind !== 'missing') narrowedBy.push('host.json');
    if (organization.kind !== 'missing') narrowedBy.push('organization.json');
    source = { kind: 'managed', path: managed.path, narrowedBy };
    if (managed.document.egress !== 'approved-scoped') reasonCode = 'MANAGED_POLICY_DENIES';
    else if (egress !== 'approved') reasonCode = host.kind === 'invalid' ? 'HOST_POLICY_INVALID' : organization.kind !== 'missing' && !(organization.kind === 'ok' && organization.document.egress === 'approved-scoped') ? 'ORGANIZATION_DENIES' : 'EGRESS_NOT_APPROVED';
  } else {
    if (organization.kind !== 'missing') narrowedBy.push('organization.json');
    source = host.kind === 'missing' ? { kind: 'default', path: null, narrowedBy } : { kind: 'host', path: hostFile, narrowedBy };
    if (egress !== 'approved') {
      reasonCode = host.kind === 'invalid' ? 'HOST_POLICY_INVALID' : host.kind === 'ok' && host.document.egress === 'approved-scoped' ? 'ORGANIZATION_DENIES' : 'EGRESS_NOT_APPROVED';
    }
  }
  const min = (pick: (d: HostDocument) => number, fallback: number): number => docs.reduce((m, d) => Math.min(m, pick(d)), fallback);
  return {
    egress,
    setting: egress === 'approved' ? 'approved-scoped' : 'deny-until-approved',
    source,
    reasonCode: egress === 'approved' ? null : reasonCode === 'MANAGED_POLICY_REFUSED' || reasonCode === 'MANAGED_POLICY_DENIES' ? reasonCode : (untrusted ?? reasonCode ?? 'EGRESS_NOT_APPROVED'),
    maySend: {
      fieldClasses: egress === 'approved' ? APPROVED_FIELDS : STRUCTURED_ONLY,
      maxRequestBytes: min((d) => d.budget.maxRequestBytes, MAX_REQUEST_BYTES),
      retention: {
        rawArtifactRetentionDays: min((d) => d.retention.rawArtifactRetentionDays, 7),
        decisionRetentionDays: min((d) => d.retention.decisionRetentionDays, 30),
      },
    },
    hostFile,
    host,
    organization,
    managed,
  };
}

const REASON_TEXT: { readonly [K in Denial]: string } = {
  EGRESS_NOT_APPROVED: 'not approved (jevris egress approve, from an interactive terminal)',
  MANAGED_POLICY_DENIES: "your organization's managed policy denies it; only your administrator can change that",
  MANAGED_POLICY_REFUSED: "your organization's managed policy failed its checks, so nothing is approved; tell your administrator",
  ORGANIZATION_DENIES: 'organization.json caps it at deny-until-approved; change or remove organization.json first',
  HOST_POLICY_INVALID: 'host.json is not a valid host policy, so it approves nothing; fix or remove it (jevris policy check)',
  AUTHORITY_FILE_SYMLINK: 'host.json or organization.json is a symbolic link, so it approves nothing; replace it with a regular file',
  AUTHORITY_FILE_NOT_REGULAR: 'host.json or organization.json is not a regular file, so it approves nothing; remove it',
  AUTHORITY_FILE_NOT_OWNER: 'host.json or organization.json is not owned by you, so it approves nothing; remove it and approve again',
  AUTHORITY_FILE_SHARED_WRITE: 'host.json or organization.json can be written by other users, so it approves nothing; chmod 600 it',
  AUTHORITY_FILE_IN_WORK_TREE: 'the Jevris config folder is inside a git work tree, so its files approve nothing; move the Jevris home out of the repository',
  JEVRIS_HOME_IN_WORK_TREE: 'the Jevris home is inside a git work tree, so a repository could supply the approval and none counts; set JEVRIS_HOME outside every repository',
};

function sourceText(v: EgressView): string {
  const where = v.source.kind === 'managed' ? `managed policy (${v.source.path ?? 'unknown'})` : v.source.kind === 'host' ? `host.json (${v.hostFile})` : 'default (no host.json)';
  return v.source.narrowedBy.length === 0 ? where : `${where}, narrowed by ${v.source.narrowedBy.join(' and ')}`;
}

function statusLines(v: EgressView, key: 'present' | 'missing'): string[] {
  return [
    v.egress === 'approved' ? 'Source egress is approved (approved-scoped).' : 'Source egress is denied (deny-until-approved).',
    `source: ${sourceText(v)}`,
    ...(v.reasonCode === null ? [] : [`reason: ${v.reasonCode}: ${REASON_TEXT[v.reasonCode]}`]),
    `may send: ${v.maySend.fieldClasses.join(', ')}`,
    `request cap: ${String(v.maySend.maxRequestBytes)} bytes per request`,
    `local retention: raw artifacts ${String(v.maySend.retention.rawArtifactRetentionDays)} days, decisions ${String(v.maySend.retention.decisionRetentionDays)} days (Jev's own retention follows the vendor's terms)`,
    `Jev key: ${key === 'present' ? 'present in the OS keychain' : 'not in the OS keychain (jevris credential set)'}`,
  ];
}

function disclosure(v: EgressView): string {
  return [
    'Approving source egress lets Jevris send, per decision, to Jev (TypeSafe System One, api.typesafe.ai):',
    '- only the fields that decision\'s question needs: categories, counts, reason codes, sizes and salted hashes, and',
    '  redacted decision text (failure text, tool output, file excerpts, diffs), each bounded;',
    '- every request is screened for secrets and sensitive paths first; a finding stops the request;',
    `- at most ${String(v.maySend.maxRequestBytes)} bytes per request (budget.maxRequestBytes).`,
    'It changes nothing your coding harness sends to its own model vendor.',
    'Jev keeps what it receives under the vendor\'s retention terms, not Jevris\'s. "Not used for training" does not mean',
    'zero retention. Local deletion (jevris data delete) is not vendor deletion.',
    `This writes egress: approved-scoped to ${v.hostFile} (owner-only). Undo it with jevris egress revoke.`,
    '',
  ].join('\n');
}

async function readLineFromStdin(prompt: string, write: Write): Promise<string | null> {
  write(prompt);
  return new Promise((resolve) => {
    const onData = (chunk: Uint8Array): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(new TextDecoder().decode(chunk).replace(/\r?\n$/, ''));
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

/** Writes host.json with `egress` set: the existing document with only `egress` changed, or the defaults. */
async function writeEgress(v: EgressView, egress: HostEgress): Promise<boolean> {
  const next = v.host.kind === 'ok' ? { ...v.host.raw, egress } : defaultHostDocument(egress);
  if (copyHostDocument(next) === undefined) return false;
  const written = await writePrivateFile(v.hostFile, `${JSON.stringify(next, null, 2)}\n`);
  return written.ok;
}

/** Runs `jevris egress ...` (argv after `egress`). */
export async function runEgressCommand(argv: readonly string[], write: Write, options: EgressCommandOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(`${EGRESS_HELP}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  let home: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json' && sub !== 'approve') json = true;
    else if (arg === '--home' && home === undefined && typeof rest[i + 1] === 'string' && (rest[i + 1] as string).length > 0) home = rest[(i += 1)];
    else if (arg !== undefined && arg.startsWith('--home=') && home === undefined && arg.length > 7) home = arg.slice(7);
    else {
      write(`Unknown or repeated argument ${String(arg).slice(0, 40)}.\nRun jevris egress --help for usage.\n`);
      return 2;
    }
  }
  if (sub !== 'status' && sub !== 'approve' && sub !== 'revoke') {
    write(`Unknown egress subcommand ${String(sub).slice(0, 40)}. Use status, approve or revoke.\n`);
    return 2;
  }
  const resolved = resolveHome(home !== undefined ? { home, env } : { env });
  const refusedHome = testHomeRefusal(resolved, env);
  if (refusedHome !== null) {
    write(`refused (${refusedHome.reasonCode}): ${refusedHome.message}\n`);
    return 2;
  }
  const resolveEgress = options.resolveEgress ?? resolveHostSourceEgress;
  const v = await view(resolved.home, resolveEgress);
  const out = (result: object, lines: readonly string[], code: number): number => {
    write(json ? `${JSON.stringify({ schemaVersion: '1.0', command: `egress ${sub}`, ...result })}\n` : `${lines.join('\n')}\n`);
    return code;
  };
  const summary = { egress: v.egress, setting: v.setting, source: v.source, reasonCode: v.reasonCode, maySend: v.maySend };

  if (sub === 'status') {
    const key = (await credentialStatus(options.openKeyring ?? openHostEntry)).presence === 'present' ? 'present' : 'missing';
    return out({ ...summary, credential: { jevKey: key } }, statusLines(v, key), 0);
  }

  if (sub === 'revoke') {
    if (v.egress !== 'approved') return out({ changed: false, ...summary }, [`Source egress is already denied (${sourceText(v)}); nothing changed.`], 0);
    const created = v.host.kind === 'missing';
    if (!(await writeEgress(v, 'deny-until-approved'))) return out({ changed: false, reasonCode: 'WRITE_FAILED' }, [`${v.hostFile} could not be written; nothing changed.`], 1);
    const after = await view(resolved.home, resolveEgress);
    await recordCliAudit('egress.revoke', { egress: 'deny-until-approved', created }, resolved.home);
    return out({ changed: true, egress: after.egress, setting: after.setting, created, path: v.hostFile }, [`Source egress is denied (deny-until-approved) in ${v.hostFile}. Requests to Jev carry only bounded structured features again.`], after.egress === 'approved' ? 1 : 0);
  }

  // approve: policy first (a denial is reported the same with or without a terminal), then a person.
  if (v.egress === 'approved') {
    write(`Source egress is already approved (${sourceText(v)}); nothing changed.\n`);
    return 0;
  }
  if (v.reasonCode !== null && v.reasonCode !== 'EGRESS_NOT_APPROVED') {
    write(`Not approved (${v.reasonCode}): ${REASON_TEXT[v.reasonCode]}. Nothing changed.\n`);
    return 1;
  }
  const interactive = options.interactive ?? (() => process.stdin.isTTY === true && Reflect.get(process.stdout, 'isTTY') === true);
  if (env['JEVRIS_TEST'] === '1' || !interactive()) {
    write('Not approved: approving egress needs a person at an interactive terminal (never MCP, a hook, a script, a pipe or a test run). Nothing changed.\n');
    return 2;
  }
  write(disclosure(v));
  const typed = await (options.readLine ?? ((prompt: string) => readLineFromStdin(prompt, write)))(`Type "${EGRESS_APPROVE_PHRASE}" to approve, anything else to cancel: `);
  if (typed === null || typed.trim() !== EGRESS_APPROVE_PHRASE) {
    write('\nNot approved: the phrase did not match. Nothing changed.\n');
    return 2;
  }
  const created = v.host.kind === 'missing';
  if (!(await writeEgress(v, 'approved-scoped'))) {
    write(`${v.hostFile} could not be written; nothing changed.\n`);
    return 1;
  }
  const after = await view(resolved.home, resolveEgress);
  if (after.egress !== 'approved') {
    write(`host.json now says approved-scoped, but egress is still denied (${after.reasonCode ?? 'EGRESS_NOT_APPROVED'}): ${REASON_TEXT[after.reasonCode ?? 'EGRESS_NOT_APPROVED']}.\n`);
    return 1;
  }
  await recordCliAudit('egress.enable', { egress: 'approved-scoped', created }, resolved.home);
  write(`Source egress approved (approved-scoped) in ${v.hostFile}${created ? ', created with the defaults' : ''}. Undo it with jevris egress revoke.\n`);
  return 0;
}
