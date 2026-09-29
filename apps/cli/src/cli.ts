import { open, type FileHandle } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isPacksPath, jevrisPaths, migrateLegacyLayout, resolveHome } from '@jevris/platform';
import { buildShadowReport, recordRecommendationFeedback, recordShadowComparison } from '@jevris/core';
import {
  clearHostSecret,
  credentialStatus,
  emitCredentialStatus,
  KEYRING_UNAVAILABLE,
  KeyringUnavailableError,
  openHostEntry,
  readConsoleSecret,
  setHostSecret,
  type OpenHostSecret,
} from './credential.js';
import { sqliteProbe } from './host-health.js';
import { runGatesCommand } from './gate-records.js';
import { confineOutputPath, screenSemanticDecision } from './host-policy.js';
import { runKillSwitchDrill } from './kill-switch.js';
import { rollbackPolicy, stagePackUpgrade } from './pack-policy.js';
import { formatShadowReport } from './shadow.js';
import { EVIDENCE_HELP, isPublicCommand, PUBLIC_HELP, runEvidenceCommand, runPublicCommand, runSurfaceCall } from './public-commands.js';
import { helpFor, jevrisVersion, readAllStdin, topLevelUsage, versionText } from './public/help.js';
import { NO_COLOR_FLAG, styledTerminal, styleFor, terminalProfile } from './terminal.js';
import { doctorLineSeverity } from './doctor-severity.js';
import { runShortlist } from './shortlist.js';
import { recordCliAudit, runRuntimeCommand } from './runtime-commands.js';
import { helpText as adminHelpText, isAdminCommand, runAdminCommand } from './admin-cli.js';
import { testHomeRefusal } from './home-guard.js';
import { OPERATOR_HELP, isOperatorHelpTopic } from './operator-help.js';
import { CONSENT_HELP, runConsentCommand } from './consent-command.js';
import { HANDOFF_HELP, runHandoffCommand } from './handoff-command.js';
import { EGRESS_HELP, runEgressCommand } from './egress-command.js';
import { FEEDBACK_HELP, runFeedbackCommand } from './feedback-command.js';
import { TASK_HELP, runTaskCommand } from './task-command.js';
import { COST_REPORT_HELP, runCostReportCommand } from './cost-report.js';
import { DELIVERY_HELP, runDeliveryCommand } from './delivery-command.js';
import { INTEGRATE_HELP, runIntegrateCommand } from './integrate-command.js';
import { ADVISE_HELP, runAdviseCommand } from './advise-command.js';
import { BUDGET_HELP, runBudgetCommand } from './budget-command.js';
import { CONTROL_HELP, runControlCommand } from './control-command.js';

const FIXTURE_BYTE_CAP = 131072;
const COMPARISON_FIELDS = [
  'policyVersion',
  'actualModel',
  'rulesInput',
  'jevLabel',
  'setting',
  'untrustedClaims',
] as const;
const FEEDBACK_FIELDS = ['policyVersion', 'recommendationId', 'reason'] as const;
const forbiddenFixtureKeys = new Set([
  'source',
  'sourceText',
  'token',
  'body',
  'message',
  'secret',
  'secretText',
  'port',
]);
const dangerousFixtureKeys = new Set(['__proto__', 'prototype', 'constructor']);

function emit(write: ((text: string) => void) | undefined, text: string): void {
  if (write !== undefined) {
    write(text);
    return;
  }
  process.stdout.write(text);
}

export function platformArg(flag: string | boolean | undefined): string {
  return typeof flag === 'string' ? flag : process.platform;
}

export function nodeVersionArg(flag: string | boolean | undefined): string {
  return typeof flag === 'string' ? flag : process.version;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

export function doctorReportStatus(text: string): 'reduced' | 'unsupported' | 'refused' {
  const line = text.split('\n').find((entry) => entry.startsWith('JEVRIS_REPORT '));
  if (line === undefined) return 'refused';
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice('JEVRIS_REPORT '.length)) as unknown;
  } catch {
    return 'refused';
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.actuators)) return 'refused';
  for (const row of parsed.actuators) {
    if (isPlainObject(row) && row.status === 'certified') return 'refused';
  }
  if (parsed.installStatus === 'reduced' || parsed.installStatus === 'unsupported') {
    return parsed.installStatus;
  }
  return 'refused';
}

export function finishDoctor(text: string, write?: (chunk: string) => void): number {
  const status = doctorReportStatus(text);
  if (status === 'refused') {
    emit(write, 'refused\n');
    return 2;
  }
  emit(write, text);
  return 0;
}

/** The options of the legacy operator parser below (values and flags of every command it runs). */
const LEGACY_OPTIONS = {
  home: { type: 'string' },
  source: { type: 'string' },
  workspace: { type: 'string' },
  project: { type: 'string' },
  'would-send-source': { type: 'boolean' },
  manifest: { type: 'string' },
  enable: { type: 'boolean' },
  platform: { type: 'string' },
  'harness-version': { type: 'string' },
  'node-version': { type: 'string' },
  'skills-root': { type: 'string' },
  'evidence-root': { type: 'string' },
  intent: { type: 'string' },
  'skill-id': { type: 'string' },
  fixture: { type: 'string' },
  out: { type: 'string' },
  root: { type: 'string' },
  ledger: { type: 'string' },
  'workspace-id': { type: 'string' },
  'host-scope': { type: 'string' },
  harness: { type: 'string' },
} as const;

/**
 * Harness parity audit G18: an admin command named after global flags (`jevris --home X install`)
 * is the admin command, never a legacy path. Returns argv with the command (and, for data, its
 * `delete`) moved to the front, or null when the first positional names no admin command.
 */
export function adminArgvAfterFlags(argv: readonly string[]): readonly string[] | null {
  // The positionals' indexes, skipping each flag and the value of one that takes a value.
  const positions: number[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') break;
    if (!arg.startsWith('-')) {
      positions.push(i);
      continue;
    }
    const name = arg.replace(/^--?/, '');
    const option = (LEGACY_OPTIONS as { readonly [key: string]: { readonly type: string } | undefined })[name];
    if (option?.type === 'string' || name === 'home') i += 1;
  }
  const first = positions[0];
  if (first === undefined || first === 0) return null;
  const moved = argv[first] === 'data' && positions[1] === first + 1 ? [first, first + 1] : [first];
  const reordered = [...moved.map((i) => argv[i] as string), ...argv.filter((_, i) => !moved.includes(i))];
  return isAdminCommand(reordered) ? reordered : null;
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

function isJevrisPacksPath(destination: string): boolean {
  return isPacksPath(destination);
}

function namedFields(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const named: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) named[key] = source[key];
  }
  return named;
}

function fixtureUnsafe(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || dangerousFixtureKeys.has(key) || forbiddenFixtureKeys.has(key)) return true;
  }
  return false;
}

async function readCappedFixture(path: string): Promise<Record<string, unknown> | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = new Uint8Array(FIXTURE_BYTE_CAP + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    await handle.close();
    handle = undefined;
    if (result.bytesRead > FIXTURE_BYTE_CAP) return undefined;
    const decoded = decodeUtf8(buffer.subarray(0, result.bytesRead));
    if (decoded === undefined) return undefined;
    const parsed = JSON.parse(decoded) as unknown;
    if (!isPlainObject(parsed) || fixtureUnsafe(parsed)) return undefined;
    return parsed;
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The error text is not stored. Nothing is written.
      }
    }
    return undefined;
  }
}

function refused(write: ((text: string) => void) | undefined): number {
  emit(write, 'refused\n');
  return 2;
}

/** A refusal that names its reason code (GOV-11 output confinement). */
function refusedWith(write: ((text: string) => void) | undefined, reasonCode: string): number {
  emit(write, `refused: ${reasonCode}\n`);
  return 2;
}

async function runShadow(
  values: { readonly [key: string]: string | boolean | undefined },
  write: ((text: string) => void) | undefined,
): Promise<number> {
  // Home is a required gate. This command does not create it and does not write under it.
  const home = values.home;
  const fixture = values.fixture;
  if (typeof home !== 'string' || home.length === 0 || typeof fixture !== 'string' || fixture.length === 0) {
    return refused(write);
  }
  const out = values.out;
  const requested = typeof out === 'string' && out.length > 0 ? out : undefined;
  if (requested !== undefined && isJevrisPacksPath(requested)) return refused(write);
  // GOV-11: --out and its .feedback.json and .draft.json siblings stay inside the approved roots
  // (working directory, home, temp), outside Jevris's private directories, and never through a link.
  let destination: string | undefined;
  if (requested !== undefined) {
    const confined = await confineOutputPath(requested, typeof home === 'string' ? { jevrisHome: home } : {});
    if (!confined.ok) return refusedWith(write, confined.reasonCode);
    for (const sibling of [`${confined.path}.feedback.json`, `${confined.path}.draft.json`]) {
      const check = await confineOutputPath(sibling, { jevrisHome: home, roots: [confined.root] });
      if (!check.ok) return refusedWith(write, check.reasonCode);
    }
    destination = confined.path;
  }

  const parsed = await readCappedFixture(fixture);
  if (parsed === undefined) return refused(write);

  const comparisonInput = namedFields(parsed, COMPARISON_FIELDS);
  const preview = await recordShadowComparison(comparisonInput);
  if (!preview.accepted) return refused(write);

  const rejected = parsed.decision === 'rejected';
  const draft = parsed.draft === true;
  let feedbackInput: Record<string, unknown> | undefined;
  if (rejected) {
    feedbackInput = namedFields(parsed, FEEDBACK_FIELDS);
    feedbackInput.decision = 'rejected';
    const feedbackPreview = await recordRecommendationFeedback(feedbackInput);
    if (!feedbackPreview.accepted) return refused(write);
  }

  if (destination !== undefined) {
    const written = await recordShadowComparison({ ...comparisonInput, destination });
    if (!written.accepted || written.fileWritten !== true) return refused(write);
    if (rejected && feedbackInput !== undefined) {
      const feedbackDestination = `${destination}.feedback.json`;
      if (isJevrisPacksPath(feedbackDestination)) return refused(write);
      const draftDestination = draft ? `${destination}.draft.json` : undefined;
      if (draftDestination !== undefined && isJevrisPacksPath(draftDestination)) return refused(write);
      const feedbackWritten = await recordRecommendationFeedback({
        ...feedbackInput,
        destination: feedbackDestination,
        ...(draftDestination !== undefined ? { draftDestination } : {}),
      });
      if (!feedbackWritten.accepted || feedbackWritten.fileWritten !== true) return refused(write);
      if (draft && feedbackWritten.draftWritten !== true) return refused(write);
    }
  }

  const built = buildShadowReport([preview.file]);
  if (!('kind' in built)) return refused(write);
  const text = formatShadowReport(built);
  if (text === 'refused\n' || text.includes('permissionDecision') || text.includes('JEVRIS_REPORT ')) {
    return refused(write);
  }
  emit(write, text);
  return 0;
}

export async function main(
  rawArgv: readonly string[],
  write?: (text: string) => void,
  hooks?: {
    readonly afterSettingsRead?: () => void | Promise<void>;
    readonly afterConfigRead?: (path: string) => void | Promise<void>;
    readonly openKeyring?: OpenHostSecret;
    readonly readStdin?: () => Uint8Array | Promise<Uint8Array>;
    readonly fetch?: () => unknown;
    readonly readCitedFile?: (path: string) => Uint8Array | 'missing' | Promise<Uint8Array | 'missing'>;
  },
): Promise<number> {
  // Terminal styling (colour, the logo) only for a real terminal on stdout; --no-color is taken
  // out here so no command sees it. Anything piped, JSON and a caller's own writer stay plain.
  const argv = rawArgv.filter((arg) => arg !== NO_COLOR_FLAG);
  const style = write === undefined ? styleFor(argv) : null;
  const profile = style === null ? null : terminalProfile(process.stdout, process.env, process.platform, argv.length !== rawArgv.length);
  const terminal = profile === null ? null : styledTerminal(profile);
  if (terminal !== null && style !== null) {
    const sink = (text: string): void => void process.stdout.write(text);
    // Doctor's marks come from doctor's own classification (F), never from the presenter.
    write = terminal.writer(style.presentation, sink, { ...(style.logoFirst ? { logoFirst: jevrisVersion() } : {}), doctorSeverity: doctorLineSeverity });
  }
  const runtimeCode = await runRuntimeCommand(argv, write); if (runtimeCode !== undefined) return runtimeCode;
  const out = (text: string): void => emit(write, text);
  // Global help, version and bare usage (ADM-01): answered before any command parsing.
  const first = argv[0];
  if (first === undefined) {
    out(await topLevelUsage());
    return 0;
  }
  if (first === '--version' || first === '-v') {
    if (terminal !== null) process.stdout.write(terminal.logo(jevrisVersion()));
    else out(`${versionText()}\n`);
    return 0;
  }
  if (first === '--help' || first === '-h') {
    out(await topLevelUsage());
    return 0;
  }
  if (first === 'help') {
    // `help data` is B's short data help (answered above); `help data delete` reaches here with
    // topic data and prints F's full data delete help from admin-cli.ts.
    const topic = argv[1];
    if (topic === undefined) {
      out(await topLevelUsage());
      return 0;
    }
    let text: string | null = isPublicCommand(topic)
      ? PUBLIC_HELP[topic]
      : topic === 'evidence'
        ? EVIDENCE_HELP
        : topic === 'task'
          ? TASK_HELP
          : topic === 'cost-report'
          ? COST_REPORT_HELP
          : topic === 'delivery'
          ? DELIVERY_HELP
          : topic === 'integrate'
          ? INTEGRATE_HELP
          : topic === 'advise'
          ? ADVISE_HELP
          : topic === 'budget'
          ? BUDGET_HELP
          : topic === 'control'
          ? CONTROL_HELP
          : topic === 'egress'
          ? EGRESS_HELP
          : topic === 'consent'
          ? CONSENT_HELP
          : topic === 'handoff'
          ? HANDOFF_HELP
          : topic === 'feedback'
          ? FEEDBACK_HELP
          : isOperatorHelpTopic(topic)
          ? (OPERATOR_HELP[topic] ?? null)
          : await helpFor(topic, adminHelpText);
    // sidecar (B) and gates (A) print their own help: one source per command.
    if (text === null && (topic === 'sidecar' || topic === 'gates')) {
      let own = '';
      await main([topic, '--help'], (chunk) => (own += chunk));
      text = own.length > 0 ? own : null;
    }
    if (text === null) {
      out(`Unknown command "${topic.slice(0, 40)}".\n\n${await topLevelUsage()}`);
      return 2;
    }
    out(text.endsWith('\n') ? text : `${text}\n`);
    return 0;
  }
  // The eight public commands (§11.2) parse their own flags; --home is optional (ADM-01).
  if (isPublicCommand(first)) {
    return runPublicCommand(first, argv.slice(1), out, { probeSqlite: sqliteProbe });
  }
  // Evidence by handle (the evidence.get operation from the CLI).
  if (first === 'evidence') return runEvidenceCommand(argv.slice(1), out);
  // Owned-task administration (CLI-only): settle an effect the kill switch held.
  if (first === 'task') return runTaskCommand(argv.slice(1), out);
  // What Jevris's own decision calls cost (C's cost.report op), three measures kept apart.
  if (first === 'cost-report') return runCostReportCommand(argv.slice(1), out);
  // A person's feedback on one decision's advice (P12, C's decision.feedback): never a policy change.
  if (first === 'feedback') return runFeedbackCommand(argv.slice(1), out);
  // Delivery reports (DLV-01..06): advice only; nothing is opened, merged, installed or run.
  if (first === 'delivery') return runDeliveryCommand(argv.slice(1), out);
  // Integration of verified owned tasks (ORC-07): CLI-only; approve needs a person.
  if (first === 'integrate') return runIntegrateCommand(argv.slice(1), out);
  // Orchestration and verification advice (US22): advice only; nothing is started or run.
  if (first === 'advise') return runAdviseCommand(argv.slice(1), out);
  // Root budgets of owned work (ORC-10): status, and a person's update (CLI-only).
  if (first === 'budget') return runBudgetCommand(argv.slice(1), out);
  // Multi-host lease authority (ORC-12): status, a person's migrate (CLI-only), and serve.
  if (first === 'control') return runControlCommand(argv.slice(1), out);
  // Source egress (GOV-01): status, a person's approve (interactive terminal only), revoke.
  if (first === 'egress') return runEgressCommand(argv.slice(1), out);
  // Per-provider consent (R30, OD-4): list, a person's grant (interactive terminal only), revoke.
  if (first === 'consent') return runConsentCommand(argv.slice(1), out);
  // Handoff import from a terminal (29423b6): the MCP tool's import, plus --link (terminal only).
  if (first === 'handoff') return runHandoffCommand(argv.slice(1), out);
  // The MCP server's internal entry: arguments as JSON on stdin, never argv.
  if (first === '__surface') {
    return runSurfaceCall(argv.slice(1), out, hooks?.readStdin !== undefined ? async () => await hooks.readStdin!() : readAllStdin);
  }
  // Release-gate records (A): own parser, before the strict shared one.
  if (first === 'gates') return runGatesCommand(argv.slice(1), write);
  // `data --help` prints B's data help (purge and delete), the same text as `jevris help data`;
  // `data delete --help` is F's and `data purge --help` is B's.
  if (first === 'data' && (argv[1] === '--help' || argv[1] === '-h')) {
    const dataHelp = await runRuntimeCommand(['help', 'data'], write);
    if (dataHelp !== undefined) return dataHelp;
  }
  // Administration (F, ADM-01..08): install, uninstall, data delete, doctor, certify.
  if (isAdminCommand(argv)) return runAdminCommand(argv, write, hooks);
  const adminAfterFlags = adminArgvAfterFlags(argv);
  if (adminAfterFlags !== null) return runAdminCommand(adminAfterFlags, write, hooks);
  // Operator commands parsed below: --help prints the same text as jevris help <command>.
  if (isOperatorHelpTopic(first) && (argv.includes('--help') || argv.includes('-h'))) {
    out(`${OPERATOR_HELP[first] ?? ''}\n`);
    return 0;
  }
  // Re-enabling Jev after a billing or account refusal (decision ea2af91a): its own parser, and a
  // person at an interactive terminal only.
  if (first === 'credential' && argv[1] === 'reenable') {
    const { runCredentialReenableCommand } = await import('./credential-reenable.js');
    return runCredentialReenableCommand(argv.slice(2), out);
  }
  let values: { readonly [key: string]: string | boolean | undefined };
  let positionals: readonly string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: LEGACY_OPTIONS,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    emit(write, 'refused\n');
    return 2;
  }

  const command = positionals[0];
  // --home is optional everywhere (ADM-01, E-16): JEVRIS_HOME, else the OS home.
  // In the test environment (JEVRIS_TEST=1) a command that names no home, or names the real one,
  // is refused before it touches anything (F's testHomeRefusal, shared with the admin commands).
  const resolvedHome = resolveHome(typeof values.home === 'string' && values.home.length > 0 ? { home: values.home } : {});
  const refusedHome = testHomeRefusal(resolvedHome);
  if (refusedHome !== null) {
    emit(write, `refused (${refusedHome.reasonCode}): ${refusedHome.message}\n`);
    return 2;
  }
  if (values.home === undefined) values = { ...values, home: resolvedHome.home };
  // Move the pre-v1.2 layout (~/.jevris, ~/.config/jevris) into the per-OS directories
  // before any command reads Jevris state. Never overwrites; doctor reports leftovers.
  const homeFlag = values.home;
  if (typeof homeFlag === 'string' && homeFlag.length > 0) {
    try {
      await migrateLegacyLayout(jevrisPaths({ home: homeFlag }));
    } catch {
      // Best effort: a failed move leaves the legacy files in place.
    }
  }

  if (command === 'shortlist') {
    const shortlistHome = values.home;
    if (typeof shortlistHome !== 'string' || shortlistHome.length === 0) {
      emit(write, 'refused\n');
      return 2;
    }
    const intentFlag = values.intent;
    const skillsFlag = values['skills-root'];
    const evidenceFlag = values['evidence-root'];
    const skillFlag = values['skill-id'];
    const text = await runShortlist({
      home: shortlistHome,
      intent: typeof intentFlag === 'string' ? intentFlag : '',
      evidenceIds: positionals.slice(1),
      ...(typeof skillsFlag === 'string' ? { skillsRoot: skillsFlag } : {}),
      ...(typeof evidenceFlag === 'string' ? { evidenceRoot: evidenceFlag } : {}),
      ...(typeof skillFlag === 'string' ? { skillId: skillFlag } : {}),
    });
    if (text === null) {
      emit(write, 'refused\n');
      return 2;
    }
    emit(write, text);
    return 0;
  }

  if (command === 'shadow') {
    return runShadow(values, write);
  }

  if (command === 'credential') {
    return runCredential(positionals, write, hooks);
  }

  if (command === 'policy') {
    return runPolicy(positionals, values, write, hooks);
  }

  if (command === 'kill-switch') {
    return runKillSwitch(positionals, values, write);
  }


  // install, uninstall, doctor and data delete are the admin commands (G18): nothing else here.
  emit(write, 'refused\n');
  return 2;
}

async function runKillSwitch(
  positionals: readonly string[],
  values: { readonly [key: string]: string | boolean | undefined },
  write: ((text: string) => void) | undefined,
): Promise<number> {
  if (positionals.length !== 2 || positionals[1] !== 'activate') return refused(write);
  const home = values.home;
  const workspace = values.workspace;
  const ledger = values.ledger;
  const workspaceId = values['workspace-id'];
  const hostScope = values['host-scope'];
  if (
    typeof home !== 'string' ||
    home.length === 0 ||
    typeof workspace !== 'string' ||
    workspace.length === 0 ||
    typeof ledger !== 'string' ||
    ledger.length === 0 ||
    typeof workspaceId !== 'string' ||
    workspaceId.length === 0 ||
    typeof hostScope !== 'string' ||
    hostScope.length === 0
  ) {
    return refused(write);
  }
  const drilled = await runKillSwitchDrill({
    home,
    workspace,
    ledgerPath: ledger,
    workspaceId,
    hostScope,
  });
  if (!drilled.ok) return refused(write);
  emit(write, drilled.text);
  return 0;
}

async function runPolicy(
  positionals: readonly string[],
  values: { readonly [key: string]: string | boolean | undefined },
  write: ((text: string) => void) | undefined,
  hooks: { readonly fetch?: () => unknown } | undefined,
): Promise<number> {
  const sub = positionals[1];
  if (positionals.length !== 2) return refused(write);
  const home = values.home;
  const workspace = values.workspace;
  if (typeof home !== 'string' || home.length === 0 || typeof workspace !== 'string' || workspace.length === 0) {
    return refused(write);
  }
  if (sub === 'stage') {
    const manifest = values.manifest;
    if (typeof manifest !== 'string' || manifest.length === 0) return refused(write);
    const staged = await stagePackUpgrade({ home, workspace, manifestPath: manifest });
    if (!staged.ok) return refused(write);
    await recordCliAudit('policy.change', { action: 'stage' }, home);
    return 0;
  }
  if (sub === 'rollback') {
    const restored = await rollbackPolicy({ home, workspace });
    if (!restored.ok) return refused(write);
    await recordCliAudit('policy.change', { action: 'rollback' }, home);
    return 0;
  }
  if (sub !== 'check' || values['would-send-source'] !== true) {
    return refused(write);
  }
  const project = values.project;
  const screened = await screenSemanticDecision({
    home,
    workspace,
    wouldSendSource: true,
    ...(typeof project === 'string' && project.length > 0 ? { project } : {}),
    ...(hooks?.fetch !== undefined ? { fetch: hooks.fetch } : {}),
  });
  if (screened.reasonCode === 'RAW_KEY_REFUSED') return refused(write);
  if (screened.explanation.length === 0) return refused(write);
  emit(write, `${screened.explanation}\n`);
  return 0;
}

async function runCredential(
  positionals: readonly string[],
  write: ((text: string) => void) | undefined,
  hooks:
    | {
        readonly openKeyring?: OpenHostSecret;
        readonly readStdin?: () => Uint8Array | Promise<Uint8Array>;
      }
    | undefined,
): Promise<number> {
  const sub = positionals[1];
  if (positionals.length !== 2 || (sub !== 'set' && sub !== 'clear' && sub !== 'status')) {
    return refused(write);
  }
  const open = hooks?.openKeyring ?? openHostEntry;
  const sink = (text: string): void => {
    emit(write, text);
  };
  if (sub === 'clear') {
    try {
      await clearHostSecret(open);
    } catch {
      return emitCredentialStatus({ presence: 'missing', diagnostic: null }, sink);
    }
    await recordCliAudit('credential.remove');
    return emitCredentialStatus(await credentialStatus(open), sink);
  }
  if (sub === 'set') {
    const reader = hooks?.readStdin;
    const loaded = reader !== undefined ? await reader() : await readConsoleSecret();
    if (!(loaded instanceof Uint8Array)) return refused(write);
    let outcome: 'present' | 'refused';
    try {
      outcome = await setHostSecret(loaded, open);
    } catch (error) {
      // A missing keyring binding is one plain line and exit 2, never a stack (BLD-13).
      if (error instanceof KeyringUnavailableError) {
        emit(write, `${KEYRING_UNAVAILABLE}\n`);
        return 2;
      }
      return refused(write);
    }
    if (outcome !== 'present') return refused(write);
    await recordCliAudit('credential.set');
    emit(write, 'present\n');
    return 0;
  }
  const view = await credentialStatus(open);
  return emitCredentialStatus(view, (text) => {
    emit(write, text);
  });
}
