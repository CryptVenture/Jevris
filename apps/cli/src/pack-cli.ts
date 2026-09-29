/**
 * `jevris pack` (PAK-01..08, W11, US28, US40): install, inspect, test, shadow, approve, canary,
 * promote, roll back, enable, disable and uninstall packs, and manage the publisher allowlist. The owner's
 * approvals (a delta, a publisher) happen only here, in the CLI: never through MCP, a hook or a
 * repository file. Approving a delta or trusting a publisher widens what Jevris may run and send,
 * so it needs a person at an interactive terminal who answers y, and refuses --yes (SR-1,
 * `personAtTerminal`). Uninstall --cleanup only removes, and takes a y/N answer or --yes.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { PACK_HELP } from './pack-help.js';
import { adviseOnly, manifestHash, packOwns } from './packs/manifest.js';
import { readPackDir } from './packs/files.js';
import { computeDelta, formatDelta } from './packs/delta.js';
import { checkCalibrationBindings } from './packs/calibration.js';
import { addPublisher, loadPublishers, removePublisher, signatureStatus } from './packs/trust.js';
import {
  approvePack,
  canaryPack,
  decodeUtf8,
  findDelta,
  getPack,
  installPack,
  listPackRecords,
  MIN_CANARY_TASKS,
  packVersionDir,
  promotePack,
  rollbackPack,
  setPackEnabled,
  shadowPack,
  testPack,
  uninstallPack,
  type PackRecord,
  type Refused,
} from './packs/registry.js';

export { PACK_HELP };

type Write = (text: string) => void;

export interface PackCommandInput {
  readonly home: string;
  readonly json: boolean;
  readonly positionals: readonly string[];
  readonly values: { readonly [key: string]: string | boolean | undefined };
  /** The package root; its packs/ folder holds the built-in packs. */
  readonly root: string;
  /** Asks the human; null when there is no terminal to ask on (stdin and stdout are not both TTYs). */
  readonly confirm: ((question: string) => Promise<boolean>) | null;
  /** The environment a test run is recognised by (JEVRIS_TEST=1); default process.env. */
  readonly env?: { readonly [key: string]: string | undefined };
  readonly shippedPublishers?: string;
  readonly nowMs?: number;
  readonly actor?: string;
}

const TARGET = /^(jevris\.[a-z][a-z0-9.-]+)@(\d{1,9}\.\d{1,9}\.\d{1,9})$/;
const PACK_ID = /^jevris\.[a-z][a-z0-9.-]+$/;

function emit(write: Write, input: PackCommandInput, sub: string, result: object, lines: readonly string[], code: number): number {
  write(input.json ? `${JSON.stringify({ schemaVersion: '1.0', command: `pack ${sub}`, ...result })}\n` : `${lines.join('\n')}\n`);
  return code;
}

function refusal(write: Write, input: PackCommandInput, sub: string, result: Refused): number {
  return emit(write, input, sub, result, [`jevris pack ${sub}: refused (${result.reasonCode})${result.detail.length > 0 ? `: ${result.detail}` : ''}`], COMMAND_EXIT_CODES.usage);
}

function usage(write: Write, problem: string): number {
  write(`${problem}\n\n${PACK_HELP}\n`);
  return COMMAND_EXIT_CODES.usage;
}

async function readJsonFile(path: string): Promise<unknown | Refused> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > 1_048_576) return { ok: false, reasonCode: 'FILE_INVALID', detail: path };
    return JSON.parse(decodeUtf8(await readFile(path))) as unknown;
  } catch {
    return { ok: false, reasonCode: 'FILE_INVALID', detail: path };
  }
}

function isRefused(value: unknown): value is Refused {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false && typeof (value as { reasonCode?: unknown }).reasonCode === 'string';
}

function recordLines(record: PackRecord): string[] {
  const versions = Object.values(record.versions).map((item) => `${item.version} ${item.stage}${item.rolledBackAt !== undefined ? ' (rolled back)' : ''}`);
  return [
    `${record.id}: active ${record.active === null ? '(none)' : `${record.active} (${record.versions[record.active]?.stage ?? '?'})`}, previous ${record.previous ?? '(none)'}`,
    `  versions: ${versions.join(', ') || '(none)'}`,
    `  workspaces: ${Object.keys(record.workspaces).length === 0 ? '(none)' : Object.keys(record.workspaces).join(', ')}`,
  ];
}

async function builtinPacks(root: string): Promise<readonly { readonly dir: string; readonly id: string; readonly version: string; readonly adviseOnly: boolean }[]> {
  const base = join(root, 'packs');
  let names: readonly string[] = [];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }
  const out: { dir: string; id: string; version: string; adviseOnly: boolean }[] = [];
  for (const name of [...names].sort()) {
    const dir = await readPackDir(join(base, name));
    if (dir.ok) out.push({ dir: join(base, name), id: dir.manifest.id, version: dir.manifest.version, adviseOnly: adviseOnly(dir.manifest) });
  }
  return out;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function inspect(write: Write, input: PackCommandInput, target: string): Promise<number> {
  let source = target;
  const match = TARGET.exec(target);
  if (match !== null && !(await isDirectory(target))) source = packVersionDir(input.home, match[1] as string, match[2] as string);
  const dir = await readPackDir(source);
  if (!dir.ok) return refusal(write, input, 'inspect', { ok: false, reasonCode: dir.reasonCode, detail: dir.detail });
  const { manifest, files } = dir;
  const record = await getPack(input.home, manifest.id);
  const publishers = await loadPublishers(input.home, ...(input.shippedPublishers === undefined ? [] : [input.shippedPublishers]));
  const signature = signatureStatus(manifest, publishers);
  let active = null;
  if (record?.active !== null && record?.active !== undefined) {
    const activeDir = await readPackDir(packVersionDir(input.home, manifest.id, record.active));
    active = activeDir.ok ? activeDir.manifest : null;
  }
  const { loadHostPolicy } = await import('./host-policy.js');
  const host = await loadHostPolicy({ home: input.home, workspace: source });
  const delta = computeDelta(manifest, active, host.active && host.document !== undefined ? host.document : null);
  const calibration = checkCalibrationBindings(manifest, files);
  const installed = record?.versions[manifest.version];
  const result = {
    ok: true,
    packId: manifest.id,
    version: manifest.version,
    manifestHash: manifestHash(manifest),
    maturity: manifest.maturity,
    defaultMode: manifest.defaultMode,
    adviseOnly: adviseOnly(manifest),
    publisher: manifest.publisher ?? null,
    signature,
    executables: (manifest.executables ?? []).map((item) => item.id),
    owns: packOwns(manifest),
    delta,
    calibration: { bound: calibration.bound.length, refused: calibration.refused },
    installed: installed === undefined ? null : { stage: installed.stage, deltaHash: installed.deltaHash },
  };
  const lines = [
    `pack ${manifest.id}@${manifest.version} (${manifest.maturity}, default mode ${manifest.defaultMode}${result.adviseOnly ? ', advise-only' : ''})`,
    `  manifest: valid, ${result.manifestHash}`,
    `  publisher: ${result.publisher ?? '(none)'}; signature: ${signature}`,
    `  executables: ${result.executables.length === 0 ? '(none, declarative)' : `${result.executables.join(', ')}${signature === 'verified' ? '' : ' (cannot activate: needs a signature from an allowlisted publisher)'}`}`,
    `  exclusive domains: ${result.owns.length === 0 ? '(none)' : result.owns.join(', ')}`,
    `  calibration: ${calibration.bound.length} bound${calibration.refused.length === 0 ? '' : `, refused: ${calibration.refused.map((item) => `${item.decisionSpecId} ${item.reasonCode}`).join(', ')}`}`,
    ...formatDelta(delta),
    installed === undefined ? '  not installed' : `  installed: ${installed.stage}${installed.deltaHash !== delta.hash ? ` (the recorded delta ${installed.deltaHash} is stale)` : ''}`,
  ];
  return emit(write, input, 'inspect', result, lines, COMMAND_EXIT_CODES.ok);
}

async function confirmed(write: Write, input: PackCommandInput, question: string, what: string, terminalOnly = false): Promise<boolean> {
  const yes = input.values['yes'] === true || input.values['y'] === true;
  if (terminalOnly) {
    const { personAtTerminal } = await import('./verify-admin.js');
    const confirm = input.confirm;
    const channel = { yes, json: input.json, env: input.env ?? process.env, interactive: () => confirm !== null, confirm };
    return personAtTerminal(channel, question, write, `${what.charAt(0).toLowerCase()}${what.slice(1)}`);
  }
  if (yes) return true;
  if (input.confirm === null || input.json) {
    write(`Nothing was changed. ${what}, so run it in a terminal to confirm, or add --yes.\n`);
    return false;
  }
  return input.confirm(question);
}

function target(value: string | undefined): { readonly id: string; readonly version: string } | null {
  const match = value === undefined ? null : TARGET.exec(value);
  return match === null ? null : { id: match[1] as string, version: match[2] as string };
}

export async function runPackCommand(input: PackCommandInput, write: Write): Promise<number> {
  const [sub, first, second] = input.positionals;
  const extra = input.positionals.length;
  const options = { ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }), ...(input.shippedPublishers === undefined ? {} : { shippedPublishers: input.shippedPublishers }), ...(input.actor === undefined ? {} : { actor: input.actor }) };
  switch (sub) {
    case 'list': {
      if (extra !== 1) return usage(write, 'jevris pack list: takes no argument');
      const records = await listPackRecords(input.home);
      const builtin = await builtinPacks(input.root);
      const lines = records.length === 0 ? ['no packs installed'] : records.flatMap(recordLines);
      for (const item of builtin) lines.push(`built-in: ${item.id} ${item.version}${item.adviseOnly ? ' (advise-only)' : ''}; install with: jevris pack install ${item.dir}`);
      return emit(write, input, 'list', { ok: true, packs: records, builtin }, lines, COMMAND_EXIT_CODES.ok);
    }
    case 'inspect':
      if (first === undefined || extra !== 2) return usage(write, 'jevris pack inspect: name one pack directory or id@version');
      return inspect(write, input, first);
    case 'install': {
      if (first === undefined || extra !== 2) return usage(write, 'jevris pack install: name one pack directory');
      const installed = await installPack(input.home, first, options);
      if (!installed.ok) return refusal(write, input, 'install', installed);
      return emit(write, input, 'install', installed, [
        `${installed.already ? 'already installed' : 'installed'}: ${installed.packId}@${installed.version} as ${installed.stage} (signature: ${installed.signature}); nothing was activated`,
        ...formatDelta(installed.delta),
        `next: jevris pack test ${installed.packId}@${installed.version}`,
      ], COMMAND_EXIT_CODES.ok);
    }
    case 'test': {
      const t = target(first);
      if (t === null || extra !== 2) return usage(write, 'jevris pack test: name one id@version');
      const tested = await testPack(input.home, t.id, t.version, options);
      if (!tested.ok) return refusal(write, input, 'test', tested);
      return emit(write, input, 'test', tested, [
        ...tested.results.map((item) => `  ${item.ok ? 'pass' : 'FAIL'} ${item.name}: ${item.reason}`),
        `stage: ${tested.stage}`,
        ...(tested.passed ? [`next: jevris shadow --fixture <labels.json> --out shadow.json, then jevris pack shadow ${t.id}@${t.version} --report shadow.json`] : []),
      ], tested.passed ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative);
    }
    case 'shadow': {
      const t = target(first);
      const report = input.values['report'];
      if (t === null || extra !== 2 || typeof report !== 'string') return usage(write, 'jevris pack shadow: name one id@version and --report <file>');
      const shadowed = await shadowPack(input.home, t.id, t.version, report, options);
      if (!shadowed.ok) return refusal(write, input, 'shadow', shadowed);
      const record = await getPack(input.home, t.id);
      const hash = record?.versions[t.version]?.deltaHash ?? '';
      return emit(write, input, 'shadow', { ...shadowed, deltaHash: hash }, [`shadow report attached: ${shadowed.recordCount} records, no actuation; stage: shadow-approved`, `next: jevris pack inspect ${t.id}@${t.version}, then jevris pack approve ${hash}`], COMMAND_EXIT_CODES.ok);
    }
    case 'approve': {
      if (first === undefined || extra !== 2 || !/^sha256:[0-9a-f]{64}$/.test(first)) return usage(write, 'jevris pack approve: name one delta hash (sha256:...)');
      const found = await findDelta(input.home, first);
      if (found === undefined) return refusal(write, input, 'approve', { ok: false, reasonCode: 'DELTA_UNKNOWN', detail: `${first}; run jevris pack inspect <id>@<version> for the current hash` });
      const question = `Approve ${found.record.id}@${found.version.version} (delta ${first})? This activates it as a canary. [y/N] `;
      if (!(await confirmed(write, input, question, 'Approving a pack delta changes what Jevris may run and send', true))) return COMMAND_EXIT_CODES.usage;
      const approved = await approvePack(input.home, first, options);
      if (!approved.ok) return refusal(write, input, 'approve', approved);
      return emit(write, input, 'approve', approved, [
        ...formatDelta(approved.delta),
        `approved: ${approved.packId}@${approved.version} is active as canary (previous: ${approved.previous ?? 'none'})`,
        `policy-previous.json: ${approved.policyPrevious ? 'written (the kill switch restores it)' : 'no host policy to snapshot'}`,
        ...(approved.backup === null ? [] : [`backup before the irreversible migration: ${approved.backup}`]),
        `next: jevris pack enable ${approved.packId} --workspace <dir>; after the canary, jevris pack canary ${approved.packId} --metrics <file>`,
      ], COMMAND_EXIT_CODES.ok);
    }
    case 'canary': {
      const metricsPath = input.values['metrics'];
      if (first === undefined || !PACK_ID.test(first) || extra !== 2 || typeof metricsPath !== 'string') return usage(write, 'jevris pack canary: name one pack id and --metrics <file>');
      const metrics = await readJsonFile(metricsPath);
      if (isRefused(metrics)) return refusal(write, input, 'canary', metrics);
      const ran = await canaryPack(input.home, first, metrics, { ...options, killSwitch: input.values['kill-switch'] === true });
      if (!ran.ok) return refusal(write, input, 'canary', ran);
      const lines = ran.regression
        ? [`canary ${first}: regression (${ran.reasons.join(', ')})`, `rolled back to: ${ran.rolledBackTo ?? 'nothing active'}`, `kill switch: ${ran.killSwitch === null ? 'not activated' : ran.killSwitch ? 'activated' : 'activation failed'}`]
        : [`canary ${first}: no regression`, `next: jevris pack promote ${first} (after at least ${MIN_CANARY_TASKS} canary tasks)`];
      return emit(write, input, 'canary', ran, lines, ran.regression ? COMMAND_EXIT_CODES.negative : COMMAND_EXIT_CODES.ok);
    }
    case 'promote':
    case 'rollback': {
      if (first === undefined || !PACK_ID.test(first) || extra !== 2) return usage(write, `jevris pack ${sub}: name one pack id`);
      if (sub === 'promote') {
        const promoted = await promotePack(input.home, first, options);
        if (!promoted.ok) return refusal(write, input, sub, promoted);
        return emit(write, input, sub, promoted, [`promoted: ${first}@${promoted.version} is stable`], COMMAND_EXIT_CODES.ok);
      }
      const rolled = await rollbackPack(input.home, first, options);
      if (!rolled.ok) return refusal(write, input, sub, rolled);
      return emit(write, input, sub, rolled, [`rolled back: ${first} ${rolled.from} -> ${rolled.to ?? 'nothing active'}; history kept`, ...(rolled.restoredBackup === null ? [] : [`data restored from: ${rolled.restoredBackup}`])], COMMAND_EXIT_CODES.ok);
    }
    case 'uninstall': {
      if (first === undefined || !PACK_ID.test(first) || extra !== 2) return usage(write, 'jevris pack uninstall: name one pack id');
      const cleanup = input.values['cleanup'] === true;
      if (cleanup && !(await confirmed(write, input, `Uninstall ${first} and delete its data and backups? This cannot be undone. [y/N] `, 'Cleanup deletes the pack data and its backups'))) return COMMAND_EXIT_CODES.usage;
      const removed = await uninstallPack(input.home, first, { ...options, cleanup });
      if (!removed.ok) return refusal(write, input, sub, removed);
      return emit(write, input, sub, removed, [
        `uninstalled: ${first}${removed.wasActive === null ? '' : ` (was active: ${removed.wasActive})`}; removed versions: ${removed.removedVersions.join(', ') || '(none)'}; history kept`,
        `no longer enabled in: ${removed.disabledIn.join(', ') || '(no workspace)'}; no workspace file was changed`,
        removed.cleanedUp ? 'data and backups: deleted' : removed.kept.length === 0 ? 'data and backups: none' : `kept until you run jevris pack uninstall ${first} --cleanup: ${removed.kept.join(', ')}`,
      ], COMMAND_EXIT_CODES.ok);
    }
    case 'enable':
    case 'disable': {
      const workspace = input.values['workspace'];
      if (first === undefined || !PACK_ID.test(first) || extra !== 2 || typeof workspace !== 'string') return usage(write, `jevris pack ${sub}: name one pack id and --workspace <dir>`);
      const changed = await setPackEnabled(input.home, first, workspace, sub === 'enable', options);
      if (!changed.ok) return refusal(write, input, sub, changed);
      return emit(write, input, sub, changed, [`${sub}d: ${first} in ${changed.workspace}`], COMMAND_EXIT_CODES.ok);
    }
    case 'publisher': {
      if (first === 'list' && extra === 2) {
        const publishers = await loadPublishers(input.home, ...(input.shippedPublishers === undefined ? [] : [input.shippedPublishers]));
        const lines = publishers.length === 0 ? ['no pack publishers are trusted'] : publishers.map((item) => `${item.id} (${item.source}): keys ${item.keys.map((key) => key.keyId).join(', ')}`);
        return emit(write, input, 'publisher list', { ok: true, publishers: publishers.map((item) => ({ id: item.id, source: item.source, keys: item.keys.map((key) => key.keyId) })) }, lines, COMMAND_EXIT_CODES.ok);
      }
      if (first === 'remove' && second !== undefined && extra === 3) {
        const removed = await removePublisher(input.home, second);
        if (!removed.ok) return refusal(write, input, 'publisher remove', { ok: false, reasonCode: removed.reasonCode, detail: second });
        return emit(write, input, 'publisher remove', removed, [`removed publisher ${second}`], COMMAND_EXIT_CODES.ok);
      }
      const keyPath = input.values['key'];
      const keyId = input.values['key-id'];
      if (first === 'add' && second !== undefined && extra === 3 && typeof keyPath === 'string' && typeof keyId === 'string') {
        let pem: string;
        try {
          pem = decodeUtf8(await readFile(keyPath));
        } catch {
          return refusal(write, input, 'publisher add', { ok: false, reasonCode: 'FILE_INVALID', detail: keyPath });
        }
        if (!(await confirmed(write, input, `Trust packs signed by ${second} (key ${keyId})? A signature identifies a publisher; it does not prove a pack is safe. [y/N] `, 'Trusting a publisher lets its signed packs run executable components', true))) return COMMAND_EXIT_CODES.usage;
        const added = await addPublisher(input.home, second, keyId, pem);
        if (!added.ok) return refusal(write, input, 'publisher add', { ok: false, reasonCode: added.reasonCode, detail: second });
        return emit(write, input, 'publisher add', added, [`trusted publisher ${second} (key ${keyId})`], COMMAND_EXIT_CODES.ok);
      }
      return usage(write, 'jevris pack publisher: list, add <id> --key <pem> --key-id <id>, or remove <id>');
    }
    default:
      return usage(write, sub === undefined ? 'jevris pack: name a subcommand' : `jevris pack: unknown subcommand ${JSON.stringify(sub)}`);
  }
}
