/**
 * The pack runtime and registry (PAK-01, PAK-02, PAK-04, PAK-05, PAK-08; W11, US28, US40).
 *
 * Layout under `<data>/packs`:
 *   <id>/<version>/        the pack's files, exactly as installed (pinned and re-checked on load)
 *   <id>/data/             the pack's own storage
 *   <id>/backups/<stamp>/  a backup taken before an irreversible storage migration, with RESTORE.txt
 *   .registry/             the registry: one record per pack (versions, stages, active and previous
 *                          version, per-workspace enablement, history), written under a lock
 *
 * Lifecycle (§11.4): draft (installed) -> fixture-tested (its fixtures pass) -> shadow-approved (a
 * shadow report with no actuation is attached) -> canary (the owner approved the delta hash; the
 * version is active) -> stable (canary metrics passed). A canary regression rolls the pack back and
 * can activate the kill switch. Rollback restores the previous version and its data backup and
 * keeps every history entry; decision records are never touched.
 */
import { readFile, readdir, lstat, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, jevrisPaths, packsDir, writePrivateFile } from '@jevris/platform';
import { openLedger, type RecordLedger } from '@jevris/orchestrator';
import { buildShadowReport, checkPackOwnership, parseShadowComparison } from '@jevris/core';
import { SHADOW_REPORT_KIND, sha256Hex, type HostDocument } from '@jevris/contracts';
import { loadHostPolicy } from '../host-policy.js';
import { activateKillSwitch, readKillSwitchStopped } from '../kill-switch.js';
import { adviseOnly, evaluateRules, manifestHash, packOwns, type PackManifest } from './manifest.js';
import { PACK_MANIFEST_FILE, packPath, readPackDir, type PackFile } from './files.js';
import { computeDelta, irreversibleMigration, type PackDelta } from './delta.js';
import { loadPublishers, signatureStatus, type SignatureStatus } from './trust.js';
import { checkCalibrationBindings, type CalibrationCheck } from './calibration.js';

export const PACK_STAGES = ['draft', 'fixture-tested', 'shadow-approved', 'canary', 'stable'] as const;
export type PackStage = (typeof PACK_STAGES)[number];

/** Canary tasks needed before promotion to stable (a proposed default, not a calibrated value). */
export const MIN_CANARY_TASKS = 20;
const DEFAULT_CANARY_TOLERANCE = 0.02;
const HISTORY_MAX = 500;
const COLLECTION = 'packs';
/** Where a pack keeps its fixtures, relative to the pack folder. */
export const PACK_FIXTURE_DIR = 'fixtures';

export interface VersionRecord {
  readonly version: string;
  readonly stage: PackStage;
  readonly installedAt: string;
  readonly manifestHash: string;
  readonly signature: SignatureStatus;
  readonly publisher: string | null;
  readonly executables: number;
  readonly owns: readonly string[];
  readonly deltaHash: string;
  readonly fromVersion: string | null;
  readonly fixtures?: { readonly passed: number; readonly failed: number; readonly at: string };
  readonly shadow?: { readonly reportHash: string; readonly recordCount: number; readonly at: string };
  readonly canary?: {
    readonly tasks: number;
    readonly verifiedSuccessRate: number;
    readonly baselineVerifiedSuccessRate: number;
    readonly privacyViolations: number;
    readonly regression: boolean;
    readonly reasons: readonly string[];
    readonly at: string;
  };
  readonly approvedAt?: string;
  readonly approvedBy?: string;
  readonly backup?: string | null;
  readonly rolledBackAt?: string;
}

export interface HistoryEvent {
  readonly at: string;
  readonly event: 'install' | 'test' | 'shadow' | 'approve' | 'canary' | 'promote' | 'rollback' | 'enable' | 'disable' | 'kill-switch' | 'uninstall';
  readonly version: string | null;
  readonly detail: string;
}

export interface PackRecord {
  readonly id: string;
  readonly active: string | null;
  readonly previous: string | null;
  readonly versions: { readonly [version: string]: VersionRecord };
  readonly workspaces: { readonly [path: string]: { readonly enabledAt: string } };
  readonly history: readonly HistoryEvent[];
}

export type Refused = { readonly ok: false; readonly reasonCode: string; readonly detail: string };
export type Result<T> = ({ readonly ok: true } & T) | Refused;

/** Strict UTF-8 decoding; throws on invalid bytes (callers treat that as invalid JSON). */
export function decodeUtf8(bytes: Uint8Array): string {
  const Ctor = (globalThis as unknown as { TextDecoder: new (label: string, options: { fatal: boolean }) => { decode(input: Uint8Array): string } }).TextDecoder;
  return new Ctor('utf-8', { fatal: true }).decode(bytes);
}

function refused(reasonCode: string, detail = ''): Refused {
  return { ok: false, reasonCode, detail };
}

export interface RegistryOptions {
  readonly nowMs?: number;
  /** The shipped publisher allowlist (tests point it at a fixture). */
  readonly shippedPublishers?: string;
  readonly actor?: string;
}

function iso(options: RegistryOptions): string {
  return new Date(options.nowMs ?? Date.now()).toISOString();
}

export function packsRoot(home: string): string {
  return packsDir(jevrisPaths({ home }));
}

export function packVersionDir(home: string, id: string, version: string): string {
  return join(packsRoot(home), id, version);
}

export function packDataDir(home: string, id: string): string {
  return join(packsRoot(home), id, 'data');
}

async function registry(home: string): Promise<RecordLedger> {
  const root = packsRoot(home);
  const made = await ensurePrivateDir(root);
  if (!made.ok) throw new Error('packs directory refused');
  return openLedger(join(root, '.registry'));
}

function withEvent(record: PackRecord, event: HistoryEvent): PackRecord['history'] {
  return [...record.history, event].slice(-HISTORY_MAX);
}

function emptyRecord(id: string): PackRecord {
  return { id, active: null, previous: null, versions: {}, workspaces: {}, history: [] };
}

export async function getPack(home: string, id: string): Promise<PackRecord | undefined> {
  return (await registry(home)).get<PackRecord>(COLLECTION, id);
}

export async function listPackRecords(home: string): Promise<readonly PackRecord[]> {
  return (await registry(home)).list<PackRecord>(COLLECTION);
}

/** The installed files of one version, checked against its pins and its recorded manifest hash. */
async function readInstalled(home: string, record: PackRecord, version: string): Promise<Result<{ readonly manifest: PackManifest; readonly files: ReadonlyMap<string, PackFile> }>> {
  const entry = record.versions[version];
  if (entry === undefined) return refused('VERSION_UNKNOWN', `${record.id}@${version}`);
  const dir = await readPackDir(packVersionDir(home, record.id, version));
  if (!dir.ok) return refused('PACK_TAMPERED', `${record.id}@${version}: ${dir.reasonCode} ${dir.detail}`);
  if (manifestHash(dir.manifest) !== entry.manifestHash) return refused('PACK_TAMPERED', `${record.id}@${version}: the manifest changed after install`);
  return { ok: true, manifest: dir.manifest, files: dir.files };
}

async function activeHostDocument(home: string): Promise<HostDocument | null> {
  const loaded = await loadHostPolicy({ home, workspace: packsRoot(home) });
  return loaded.active && loaded.document !== undefined ? loaded.document : null;
}

async function activeManifest(home: string, record: PackRecord | undefined): Promise<Result<{ readonly manifest: PackManifest | null }>> {
  if (record === undefined || record.active === null) return { ok: true, manifest: null };
  const installed = await readInstalled(home, record, record.active);
  return installed.ok ? { ok: true, manifest: installed.manifest } : installed;
}

export interface InstallOutcome {
  readonly packId: string;
  readonly version: string;
  readonly stage: PackStage;
  readonly signature: SignatureStatus;
  readonly delta: PackDelta;
  readonly already: boolean;
}

/** Installs a pack directory as a draft and computes its delta. Nothing activates (W11). */
export async function installPack(home: string, source: string, options: RegistryOptions = {}): Promise<Result<InstallOutcome>> {
  const dir = await readPackDir(source);
  if (!dir.ok) return refused(dir.reasonCode, dir.detail);
  const { manifest } = dir;
  const hash = manifestHash(manifest);
  const ledger = await registry(home);
  const existing = ledger.get<PackRecord>(COLLECTION, manifest.id);
  const publishers = await loadPublishers(home, ...(options.shippedPublishers === undefined ? [] : [options.shippedPublishers]));
  const signature = signatureStatus(manifest, publishers);
  const baseline = await activeManifest(home, existing);
  if (!baseline.ok) return baseline;
  const delta = computeDelta(manifest, baseline.manifest, await activeHostDocument(home));
  const already = existing?.versions[manifest.version];
  if (already !== undefined) {
    if (already.manifestHash !== hash) return refused('VERSION_EXISTS', `${manifest.id}@${manifest.version} is installed with different contents; bump the version`);
    return { ok: true, packId: manifest.id, version: manifest.version, stage: already.stage, signature, delta, already: true };
  }
  // Copy into a private staging folder, re-read it, then move it into place in one rename.
  const target = packVersionDir(home, manifest.id, manifest.version);
  const staging = join(packsRoot(home), manifest.id, `.staging-${sha256Hex(`${hash}${process.pid}${options.nowMs ?? Date.now()}`).slice(0, 12)}`);
  await rm(staging, { recursive: true, force: true });
  for (const file of dir.files.values()) {
    const written = await writePrivateFile(packPath(staging, file.path), file.bytes);
    if (!written.ok) {
      await rm(staging, { recursive: true, force: true });
      return refused('INSTALL_WRITE_FAILED', file.path);
    }
  }
  const copied = await readPackDir(staging);
  if (!copied.ok || manifestHash(copied.manifest) !== hash) {
    await rm(staging, { recursive: true, force: true });
    return refused('INSTALL_WRITE_FAILED', 'the copy does not match the source');
  }
  try {
    await rename(staging, target);
  } catch {
    await rm(staging, { recursive: true, force: true });
    const now = await readPackDir(target);
    if (now.ok && manifestHash(now.manifest) === hash) return { ok: true, packId: manifest.id, version: manifest.version, stage: 'draft', signature, delta, already: true };
    return refused('VERSION_EXISTS', `${manifest.id}@${manifest.version}`);
  }
  const at = iso(options);
  await ledger.transact((tx) => {
    const record = tx.get<PackRecord>(COLLECTION, manifest.id) ?? emptyRecord(manifest.id);
    if (record.versions[manifest.version] !== undefined) return;
    const entry: VersionRecord = {
      version: manifest.version,
      stage: 'draft',
      installedAt: at,
      manifestHash: hash,
      signature,
      publisher: manifest.publisher ?? null,
      executables: (manifest.executables ?? []).length,
      owns: packOwns(manifest),
      deltaHash: delta.hash,
      fromVersion: delta.fromVersion,
    };
    tx.put(COLLECTION, manifest.id, {
      ...record,
      versions: { ...record.versions, [manifest.version]: entry },
      history: withEvent(record, { at, event: 'install', version: manifest.version, detail: `delta ${delta.hash} (${delta.items.length} items), signature ${signature}` }),
    });
  });
  return { ok: true, packId: manifest.id, version: manifest.version, stage: 'draft', signature, delta, already: false };
}

function setVersion(record: PackRecord, version: string, patch: Partial<VersionRecord>): PackRecord['versions'] {
  const entry = record.versions[version];
  if (entry === undefined) return record.versions;
  return { ...record.versions, [version]: { ...entry, ...patch } };
}

export interface FixtureResult {
  readonly name: string;
  readonly ok: boolean;
  readonly reason: string;
}

function readFixture(files: ReadonlyMap<string, PackFile>, name: string): { readonly decision: string; readonly outcome: Record<string, unknown>; readonly expect: string } | string {
  // A pack's own fixture folder (manifest-relative, inside the installed pack).
  const file = files.get([PACK_FIXTURE_DIR, `${name}.json`].join('/'));
  if (file === undefined) return 'FIXTURE_MISSING';
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(file.bytes));
  } catch {
    return 'FIXTURE_INVALID';
  }
  const value = parsed as { readonly decision?: unknown; readonly outcome?: unknown; readonly expect?: unknown } | null;
  const expect = (value?.expect as { readonly action?: unknown } | undefined)?.action;
  if (value === null || typeof value.decision !== 'string' || typeof value.outcome !== 'object' || value.outcome === null || Array.isArray(value.outcome) || typeof expect !== 'string') return 'FIXTURE_INVALID';
  return { decision: value.decision, outcome: value.outcome as Record<string, unknown>, expect };
}

/** Runs a version's fixtures against its declarative rules. All pass: the stage becomes fixture-tested. */
export async function testPack(home: string, id: string, version: string, options: RegistryOptions = {}): Promise<Result<{ readonly results: readonly FixtureResult[]; readonly passed: boolean; readonly stage: PackStage }>> {
  const ledger = await registry(home);
  const record = ledger.get<PackRecord>(COLLECTION, id);
  if (record === undefined) return refused('PACK_UNKNOWN', id);
  const installed = await readInstalled(home, record, version);
  if (!installed.ok) return installed;
  const { manifest, files } = installed;
  const decisions = new Set((manifest.decisions ?? []).map((item) => item.id));
  const results: FixtureResult[] = [];
  for (const name of manifest.fixtures) {
    const fixture = readFixture(files, name);
    if (typeof fixture === 'string') {
      results.push({ name, ok: false, reason: fixture });
      continue;
    }
    if (!decisions.has(fixture.decision)) {
      results.push({ name, ok: false, reason: 'FIXTURE_DECISION_UNKNOWN' });
      continue;
    }
    const o = fixture.outcome;
    const got = evaluateRules(manifest, {
      decision: fixture.decision,
      ...(typeof o['selected'] === 'string' ? { selected: o['selected'] } : {}),
      ...(typeof o['score'] === 'number' ? { score: o['score'] } : {}),
      ...(typeof o['noul'] === 'boolean' ? { noul: o['noul'] } : {}),
      ...(o['abstained'] === true ? { abstained: true } : {}),
    });
    results.push({ name, ok: got.action === fixture.expect, reason: got.action === fixture.expect ? `action ${got.action}` : `expected ${fixture.expect}, got ${got.action}` });
  }
  if (results.length === 0) {
    // A pack with declarative decisions or rules must prove them with fixtures; a pack with
    // neither (advice metadata only, like the built-in packs) has nothing to test.
    const nothingToTest = decisions.size === 0 && (manifest.rules ?? []).length === 0;
    results.push({ name: '(none)', ok: nothingToTest, reason: nothingToTest ? 'NO_DECISIONS' : 'NO_FIXTURES' });
  }
  const passed = results.every((item) => item.ok);
  const at = iso(options);
  const failed = results.filter((item) => !item.ok).length;
  let stage: PackStage = record.versions[version]?.stage ?? 'draft';
  await ledger.transact((tx) => {
    const now = tx.get<PackRecord>(COLLECTION, id);
    if (now === undefined) return;
    const current = now.versions[version]?.stage ?? 'draft';
    stage = current === 'draft' && passed ? 'fixture-tested' : !passed && current === 'fixture-tested' ? 'draft' : current;
    tx.put(COLLECTION, id, {
      ...now,
      versions: setVersion(now, version, { stage, fixtures: { passed: results.length - failed, failed, at } }),
      history: withEvent(now, { at, event: 'test', version, detail: `${results.length - failed} of ${results.length} fixtures passed` }),
    });
  });
  return { ok: true, results, passed, stage };
}

/** Attaches a shadow report (no actuation, at least one record): the stage becomes shadow-approved. */
export async function shadowPack(home: string, id: string, version: string, reportPath: string, options: RegistryOptions = {}): Promise<Result<{ readonly recordCount: number; readonly reportHash: string }>> {
  const ledger = await registry(home);
  const record = ledger.get<PackRecord>(COLLECTION, id);
  const entry = record?.versions[version];
  if (record === undefined || entry === undefined) return refused('VERSION_UNKNOWN', `${id}@${version}`);
  if (entry.stage !== 'fixture-tested' && entry.stage !== 'shadow-approved') return refused('STAGE_NOT_READY', `${id}@${version} is ${entry.stage}; run jevris pack test first`);
  let bytes: Uint8Array;
  try {
    const st = await lstat(reportPath);
    if (!st.isFile() || st.size > 1_048_576) return refused('SHADOW_REPORT_INVALID', 'not a file of at most 1 MiB');
    bytes = await readFile(reportPath);
  } catch {
    return refused('SHADOW_REPORT_INVALID', 'unreadable');
  }
  type ShadowFields = { readonly kind?: unknown; readonly schemaVersion?: unknown; readonly recordCount?: unknown; readonly actuationCount?: unknown };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    parsed = null;
  }
  // JEV-0036: `jevris shadow --out` writes one comparison record, and the documented flow hands that file
  // straight to `pack shadow --report`. A record that passes the strict comparison check counts as a
  // report of one record, built the same way `jevris shadow` builds its own report. Anything else must
  // be a well-formed report, as before.
  let recordCount: number;
  const comparison = parseShadowComparison(parsed);
  if (comparison !== undefined) {
    const built = buildShadowReport([comparison]);
    if ('refused' in built) return refused('SHADOW_REPORT_INVALID', 'the shadow run actuated');
    recordCount = built.recordCount;
  } else {
    const report = (typeof parsed === 'object' && parsed !== null ? parsed : null) as ShadowFields | null;
    if (report === null || report.kind !== SHADOW_REPORT_KIND || report.schemaVersion !== '1.0') return refused('SHADOW_REPORT_INVALID', `not a ${SHADOW_REPORT_KIND} or a shadow comparison record (jevris shadow --out)`);
    if (typeof report.recordCount !== 'number' || !Number.isInteger(report.recordCount) || report.recordCount < 1) return refused('SHADOW_REPORT_INVALID', 'no shadow records');
    if (report.actuationCount !== 0) return refused('SHADOW_REPORT_INVALID', 'the shadow run actuated');
    recordCount = report.recordCount;
  }
  const reportHash = `sha256:${sha256Hex(bytes)}`;
  const at = iso(options);
  await ledger.transact((tx) => {
    const now = tx.get<PackRecord>(COLLECTION, id);
    if (now === undefined) return;
    tx.put(COLLECTION, id, {
      ...now,
      versions: setVersion(now, version, { stage: 'shadow-approved', shadow: { reportHash, recordCount, at } }),
      history: withEvent(now, { at, event: 'shadow', version, detail: `${recordCount} shadow records, ${reportHash}` }),
    });
  });
  return { ok: true, recordCount, reportHash };
}

/** Copies a directory tree (regular files only; a link refuses the copy). */
async function copyTree(from: string, to: string): Promise<boolean> {
  let names: readonly string[];
  try {
    names = await readdir(from);
  } catch {
    return false;
  }
  const made = await ensurePrivateDir(to);
  if (!made.ok) return false;
  for (const name of names) {
    const source = join(from, name);
    const st = await lstat(source);
    if (st.isSymbolicLink()) return false;
    if (st.isDirectory()) {
      if (!(await copyTree(source, join(to, name)))) return false;
      continue;
    }
    if (!st.isFile()) return false;
    const bytes = await readFile(source);
    const written = await writePrivateFile(join(to, name), bytes);
    if (!written.ok) return false;
    const back = await readFile(join(to, name));
    if (sha256Hex(back) !== sha256Hex(bytes)) return false;
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** PAK-05: before an irreversible migration, the pack's data is exported to a verified backup. */
async function backupPackData(home: string, id: string, fromVersion: string | null, toVersion: string, options: RegistryOptions): Promise<Result<{ readonly backup: string }>> {
  const stamp = iso(options).replace(/[:.]/g, '-');
  const backup = join(packsRoot(home), id, 'backups', `${stamp}-${fromVersion ?? 'none'}`);
  const data = packDataDir(home, id);
  const copied = (await exists(data)) ? await copyTree(data, join(backup, 'data')) : (await ensurePrivateDir(join(backup, 'data'))).ok;
  if (!copied) return refused('BACKUP_FAILED', backup);
  const restore = [
    `Backup of ${id} data taken before activating ${toVersion}, whose storage migration is irreversible.`,
    `Restore it with: jevris pack rollback ${id}`,
    `That restores version ${fromVersion ?? '(none)'} and copies this data folder back; the replaced data is kept beside it.`,
    '',
  ].join('\n');
  const written = await writePrivateFile(join(backup, 'RESTORE.txt'), restore);
  return written.ok ? { ok: true, backup } : refused('BACKUP_FAILED', backup);
}

/** US40, PAK-04: activation snapshots the active host policy as policy-previous.json. */
async function snapshotHostPolicy(home: string): Promise<boolean> {
  const config = jevrisPaths({ home }).config;
  for (const name of ['policy-active.json', 'host.json']) {
    let bytes: Uint8Array;
    try {
      const st = await lstat(join(config, name));
      if (!st.isFile() || st.size > 1_048_576) continue;
      bytes = await readFile(join(config, name));
    } catch {
      continue;
    }
    return (await writePrivateFile(join(config, 'policy-previous.json'), bytes)).ok;
  }
  return false;
}

function ownershipConflict(claims: readonly { readonly packId: string; readonly owns: readonly string[] }[]): string | null {
  const checked = checkPackOwnership(claims);
  if (checked.ok) return null;
  return checked.conflicts.map((conflict) => `${conflict.domain}: ${conflict.packs.join(', ')}`).join('; ');
}

export interface ApproveOutcome {
  readonly packId: string;
  readonly version: string;
  readonly previous: string | null;
  readonly delta: PackDelta;
  readonly backup: string | null;
  readonly policyPrevious: boolean;
}

/** Finds the pack version whose recorded delta hash is `deltaHash`. */
export async function findDelta(home: string, deltaHash: string): Promise<{ readonly record: PackRecord; readonly version: VersionRecord } | undefined> {
  for (const record of await listPackRecords(home)) {
    for (const version of Object.values(record.versions)) if (version.deltaHash === deltaHash) return { record, version };
  }
  return undefined;
}

/**
 * The owner approves one delta (PAK-02, PAK-03, PAK-04). The delta is recomputed first; the
 * approval activates that version as canary and writes policy-previous.json. The caller has
 * already confirmed with the human (a terminal answer or --yes).
 */
export async function approvePack(home: string, deltaHash: string, options: RegistryOptions = {}): Promise<Result<ApproveOutcome>> {
  const found = await findDelta(home, deltaHash);
  if (found === undefined) return refused('DELTA_UNKNOWN', `${deltaHash}; run jevris pack inspect <id>@<version> for the current hash`);
  const { record, version } = found;
  if (version.stage !== 'shadow-approved') return refused('STAGE_NOT_READY', `${record.id}@${version.version} is ${version.stage}; it needs fixture tests and a shadow report first`);
  if (await readKillSwitchStopped(home)) return refused('KILL_SWITCH_ACTIVE', 'no pack activates while the kill switch is stopped');
  const candidate = await readInstalled(home, record, version.version);
  if (!candidate.ok) return candidate;
  const baseline = await activeManifest(home, record);
  if (!baseline.ok) return baseline;
  const delta = computeDelta(candidate.manifest, baseline.manifest, await activeHostDocument(home));
  const ledger = await registry(home);
  if (delta.hash !== deltaHash) {
    await ledger.transact((tx) => {
      const now = tx.get<PackRecord>(COLLECTION, record.id);
      if (now !== undefined) tx.put(COLLECTION, record.id, { ...now, versions: setVersion(now, version.version, { deltaHash: delta.hash, fromVersion: delta.fromVersion }) });
    });
    return refused('DELTA_STALE', `the active version or host policy changed; the delta is now ${delta.hash}`);
  }
  const ceiling = delta.items.filter((item) => item.policy === 'ceiling');
  if (ceiling.length > 0) return refused('POLICY_CEILING', ceiling.map((item) => `${item.reasonCode} ${item.value}`).join('; '));
  if ((candidate.manifest.executables ?? []).length > 0) {
    const publishers = await loadPublishers(home, ...(options.shippedPublishers === undefined ? [] : [options.shippedPublishers]));
    const status = signatureStatus(candidate.manifest, publishers);
    if (status === 'unsigned') return refused('UNSIGNED_EXECUTABLE', 'an unsigned pack cannot activate an executable component');
    if (status !== 'verified') return refused('PUBLISHER_NOT_ALLOWED', `signature ${status}; add the publisher with jevris pack publisher add`);
  }
  const calibration = checkCalibrationBindings(candidate.manifest, candidate.files);
  if (calibration.refused.length > 0) return refused('CALIBRATION_MISMATCH', calibration.refused.map((item) => `${item.decisionSpecId} ${item.modelId}: ${item.reasonCode} ${item.detail}`).join('; '));
  const others = (await listPackRecords(home)).filter((item) => item.id !== record.id && item.active !== null);
  const conflict = ownershipConflict([...others.map((item) => ({ packId: item.id, owns: item.versions[item.active ?? '']?.owns ?? [] })), { packId: record.id, owns: packOwns(candidate.manifest) }]);
  if (conflict !== null) return refused('EXCLUSIVE_CONFLICT', conflict);
  let backup: string | null = null;
  if (irreversibleMigration(delta) !== undefined) {
    const taken = await backupPackData(home, record.id, record.active, version.version, options);
    if (!taken.ok) return taken;
    backup = taken.backup;
  }
  const policyPrevious = await snapshotHostPolicy(home);
  const at = iso(options);
  const outcome = await ledger.transact((tx): Result<ApproveOutcome> => {
    const now = tx.get<PackRecord>(COLLECTION, record.id);
    if (now === undefined || now.active !== record.active) return refused('DELTA_STALE', 'the active version changed during approval');
    tx.put(COLLECTION, record.id, {
      ...now,
      active: version.version,
      previous: now.active,
      versions: setVersion(now, version.version, { stage: 'canary', approvedAt: at, approvedBy: options.actor ?? 'cli', backup }),
      history: withEvent(now, { at, event: 'approve', version: version.version, detail: `approved ${deltaHash}; active as canary (previous ${now.active ?? 'none'})${backup === null ? '' : `; backup ${backup}`}` }),
    });
    return { ok: true, packId: record.id, version: version.version, previous: now.active, delta, backup, policyPrevious };
  });
  return outcome;
}

async function restoreBackup(home: string, id: string, backup: string, options: RegistryOptions): Promise<boolean> {
  const data = packDataDir(home, id);
  if (await exists(data)) {
    const aside = `${data}.replaced-${iso(options).replace(/[:.]/g, '-')}`;
    try {
      await rename(data, aside);
    } catch {
      return false;
    }
  }
  return copyTree(join(backup, 'data'), data);
}

/** Rolls the pack back to its previous version (or deactivates it). History is kept (US40). */
export async function rollbackPack(home: string, id: string, options: RegistryOptions & { readonly reason?: string } = {}): Promise<Result<{ readonly from: string; readonly to: string | null; readonly restoredBackup: string | null }>> {
  const ledger = await registry(home);
  const record = ledger.get<PackRecord>(COLLECTION, id);
  if (record === undefined || record.active === null) return refused('NOTHING_ACTIVE', id);
  const from = record.active;
  const backup = record.versions[from]?.backup ?? null;
  if (backup !== null && !(await restoreBackup(home, id, backup, options))) return refused('RESTORE_FAILED', backup);
  const at = iso(options);
  return ledger.transact((tx) => {
    const now = tx.get<PackRecord>(COLLECTION, id) ?? record;
    const to = now.previous;
    tx.put(COLLECTION, id, {
      ...now,
      active: to,
      previous: null,
      versions: setVersion(now, from, { rolledBackAt: at }),
      history: withEvent(now, { at, event: 'rollback', version: from, detail: `rolled back to ${to ?? 'nothing active'}${options.reason === undefined ? '' : ` (${options.reason})`}${backup === null ? '' : `; data restored from ${backup}`}` }),
    });
    return { ok: true as const, from, to, restoredBackup: backup };
  });
}

export interface CanaryMetrics {
  readonly tasks: number;
  readonly verifiedSuccessRate: number;
  readonly baselineVerifiedSuccessRate: number;
  readonly privacyViolations: number;
  readonly tolerance: number;
}

function readMetrics(value: unknown, id: string, version: string): CanaryMetrics | string {
  const m = value as Record<string, unknown> | null;
  if (m === null || typeof m !== 'object' || m['schemaVersion'] !== '1.0') return 'CANARY_METRICS_INVALID';
  if (m['packId'] !== id || m['version'] !== version) return 'CANARY_METRICS_OTHER_PACK';
  const rate = (key: string): number | null => (typeof m[key] === 'number' && (m[key] as number) >= 0 && (m[key] as number) <= 1 ? (m[key] as number) : null);
  const count = (key: string): number | null => (typeof m[key] === 'number' && Number.isInteger(m[key]) && (m[key] as number) >= 0 ? (m[key] as number) : null);
  const tasks = count('tasks');
  const privacyViolations = count('privacyViolations');
  const verifiedSuccessRate = rate('verifiedSuccessRate');
  const baselineVerifiedSuccessRate = rate('baselineVerifiedSuccessRate');
  const tolerance = m['tolerance'] === undefined ? DEFAULT_CANARY_TOLERANCE : typeof m['tolerance'] === 'number' && m['tolerance'] >= 0 && m['tolerance'] <= 0.5 ? m['tolerance'] : null;
  if (tasks === null || privacyViolations === null || verifiedSuccessRate === null || baselineVerifiedSuccessRate === null || tolerance === null) return 'CANARY_METRICS_INVALID';
  return { tasks, verifiedSuccessRate, baselineVerifiedSuccessRate, privacyViolations, tolerance };
}

export interface CanaryOutcome {
  readonly regression: boolean;
  readonly reasons: readonly string[];
  readonly rolledBackTo: string | null;
  readonly killSwitch: boolean | null;
}

/**
 * Records canary metrics for the active canary version (PAK-04, US40, R12). A privacy violation
 * or a verified-success rate below the baseline by more than the tolerance is a regression: the
 * pack rolls back, and the kill switch is activated for a privacy violation or when asked.
 */
export async function canaryPack(home: string, id: string, metrics: unknown, options: RegistryOptions & { readonly killSwitch?: boolean } = {}): Promise<Result<CanaryOutcome>> {
  const ledger = await registry(home);
  const record = ledger.get<PackRecord>(COLLECTION, id);
  const version = record?.active ?? null;
  if (record === undefined || version === null || record.versions[version]?.stage !== 'canary') return refused('STAGE_NOT_READY', `${id} has no active canary version`);
  const read = readMetrics(metrics, id, version);
  if (typeof read === 'string') return refused(read, `${id}@${version}`);
  const reasons: string[] = [];
  if (read.privacyViolations > 0) reasons.push('PRIVACY_VIOLATION');
  if (read.tasks > 0 && read.verifiedSuccessRate < read.baselineVerifiedSuccessRate - read.tolerance) reasons.push('QUALITY_REGRESSION');
  const regression = reasons.length > 0;
  const at = iso(options);
  await ledger.transact((tx) => {
    const now = tx.get<PackRecord>(COLLECTION, id);
    if (now === undefined) return;
    tx.put(COLLECTION, id, {
      ...now,
      versions: setVersion(now, version, { canary: { tasks: read.tasks, verifiedSuccessRate: read.verifiedSuccessRate, baselineVerifiedSuccessRate: read.baselineVerifiedSuccessRate, privacyViolations: read.privacyViolations, regression, reasons, at } }),
      history: withEvent(now, { at, event: 'canary', version, detail: `${read.tasks} tasks, verified ${read.verifiedSuccessRate} vs baseline ${read.baselineVerifiedSuccessRate}, ${read.privacyViolations} privacy violations${regression ? `: ${reasons.join(', ')}` : ''}` }),
    });
  });
  if (!regression) return { ok: true, regression, reasons, rolledBackTo: null, killSwitch: null };
  const rolled = await rollbackPack(home, id, { ...options, reason: reasons.join(', ') });
  let killSwitch: boolean | null = null;
  if (options.killSwitch === true || reasons.includes('PRIVACY_VIOLATION')) {
    const activated = await activateKillSwitch({ home, actor: options.actor ?? 'jevris-pack-canary', channel: 'cli', reason: `PACK_CANARY_REGRESSION ${id}@${version}: ${reasons.join(', ')}`, ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }) });
    killSwitch = activated.stopped;
    await ledger.transact((tx) => {
      const now = tx.get<PackRecord>(COLLECTION, id);
      if (now !== undefined) tx.put(COLLECTION, id, { ...now, history: withEvent(now, { at, event: 'kill-switch', version, detail: activated.stopped ? 'kill switch activated' : 'kill switch activation failed' }) });
    });
  }
  return { ok: true, regression, reasons, rolledBackTo: rolled.ok ? rolled.to : null, killSwitch };
}

/** Canary to stable, after passing canary metrics over enough tasks. */
export async function promotePack(home: string, id: string, options: RegistryOptions = {}): Promise<Result<{ readonly version: string }>> {
  const ledger = await registry(home);
  const record = ledger.get<PackRecord>(COLLECTION, id);
  const version = record?.active ?? null;
  const entry = version === null ? undefined : record?.versions[version];
  if (record === undefined || version === null || entry === undefined || entry.stage !== 'canary') return refused('STAGE_NOT_READY', `${id} has no active canary version`);
  if (entry.canary === undefined || entry.canary.regression || entry.canary.tasks < MIN_CANARY_TASKS) {
    return refused('CANARY_INSUFFICIENT', `needs passing canary metrics over at least ${MIN_CANARY_TASKS} tasks (jevris pack canary ${id} --metrics <file>)`);
  }
  const at = iso(options);
  await ledger.transact((tx) => {
    const now = tx.get<PackRecord>(COLLECTION, id);
    if (now === undefined) return;
    tx.put(COLLECTION, id, { ...now, versions: setVersion(now, version, { stage: 'stable' }), history: withEvent(now, { at, event: 'promote', version, detail: 'canary to stable' }) });
  });
  return { ok: true, version };
}

async function workspaceKey(workspace: string): Promise<string | null> {
  try {
    const real = await realpath(workspace);
    const st = await lstat(real);
    return st.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Enables or disables an active pack in one workspace (PAK-01). */
export async function setPackEnabled(home: string, id: string, workspace: string, enabled: boolean, options: RegistryOptions = {}): Promise<Result<{ readonly workspace: string }>> {
  const key = await workspaceKey(workspace);
  if (key === null) return refused('WORKSPACE_MISSING', workspace);
  const ledger = await registry(home);
  const record = ledger.get<PackRecord>(COLLECTION, id);
  if (record === undefined) return refused('PACK_UNKNOWN', id);
  if (enabled) {
    if (record.active === null) return refused('NOTHING_ACTIVE', `${id} has no approved version`);
    const others = (await listPackRecords(home)).filter((item) => item.id !== id && item.active !== null && item.workspaces[key] !== undefined);
    const conflict = ownershipConflict([...others.map((item) => ({ packId: item.id, owns: item.versions[item.active ?? '']?.owns ?? [] })), { packId: id, owns: record.versions[record.active]?.owns ?? [] }]);
    if (conflict !== null) return refused('EXCLUSIVE_CONFLICT', conflict);
  }
  const at = iso(options);
  await ledger.transact((tx) => {
    const now = tx.get<PackRecord>(COLLECTION, id);
    if (now === undefined) return;
    const workspaces: Record<string, { readonly enabledAt: string }> = { ...now.workspaces };
    if (enabled) workspaces[key] = { enabledAt: at };
    else delete workspaces[key];
    tx.put(COLLECTION, id, { ...now, workspaces, history: withEvent(now, { at, event: enabled ? 'enable' : 'disable', version: now.active, detail: key }) });
  });
  return { ok: true, workspace: key };
}

export interface UninstallOutcome {
  readonly packId: string;
  /** The version that was active, now deactivated; null when none was. */
  readonly wasActive: string | null;
  readonly removedVersions: readonly string[];
  /** Workspaces where the pack was enabled; only that record is dropped, no workspace file changes. */
  readonly disabledIn: readonly string[];
  /** The pack's data and backups, kept for a later install or recovery until --cleanup. */
  readonly kept: readonly string[];
  readonly cleanedUp: boolean;
}

/**
 * W11: uninstalling a pack removes only its own entries: its installed version folders and its
 * enablement in each workspace. Nothing in a workspace is touched. Its data folder and backups
 * are kept until the owner asks for cleanup (which removes the pack's whole folder). The registry
 * record stays, with no versions, so the history still shows what ran and when.
 */
export async function uninstallPack(home: string, id: string, options: RegistryOptions & { readonly cleanup?: boolean } = {}): Promise<Result<UninstallOutcome>> {
  const ledger = await registry(home);
  const record = ledger.get<PackRecord>(COLLECTION, id);
  if (record === undefined) return refused('PACK_UNKNOWN', id);
  const at = iso(options);
  const cleanup = options.cleanup === true;
  const before = await ledger.transact((tx) => {
    const now = tx.get<PackRecord>(COLLECTION, id) ?? record;
    tx.put(COLLECTION, id, {
      ...now,
      active: null,
      previous: null,
      versions: {},
      workspaces: {},
      history: withEvent(now, { at, event: 'uninstall', version: now.active, detail: `removed ${Object.keys(now.versions).join(', ') || 'no versions'}${cleanup ? '; data and backups removed' : '; data and backups kept'}` }),
    });
    return now;
  });
  // The record no longer names any version, so nothing loads them while their folders go.
  const removedVersions = Object.keys(before.versions);
  for (const version of removedVersions) {
    try {
      await rm(packVersionDir(home, id, version), { recursive: true, force: true });
    } catch {
      return refused('REMOVE_FAILED', packVersionDir(home, id, version));
    }
  }
  const kept: string[] = [];
  if (cleanup) {
    try {
      await rm(join(packsRoot(home), id), { recursive: true, force: true });
    } catch {
      return refused('REMOVE_FAILED', join(packsRoot(home), id));
    }
  } else {
    for (const path of [packDataDir(home, id), join(packsRoot(home), id, 'backups')]) if (await exists(path)) kept.push(path);
  }
  return { ok: true, packId: id, wasActive: before.active, removedVersions, disabledIn: Object.keys(before.workspaces), kept, cleanedUp: cleanup };
}

export interface LoadedPack {
  readonly id: string;
  readonly version: string;
  readonly stage: PackStage;
  /** The mode this pack actually runs in here: never above its default. */
  readonly mode: 'off' | 'observe' | 'advise' | 'bounded-auto';
  readonly reasons: readonly string[];
  readonly manifest: PackManifest | null;
  readonly calibration: CalibrationCheck | null;
  /** Executable components that may run (signed by an allowlisted publisher, approved). */
  readonly executables: readonly string[];
}

const MODE_RANK = { off: 0, observe: 1, advise: 2, 'bounded-auto': 3 } as const;

function capMode(mode: LoadedPack['mode'], cap: LoadedPack['mode']): LoadedPack['mode'] {
  return MODE_RANK[mode] <= MODE_RANK[cap] ? mode : cap;
}

export interface LoadContext {
  /** The harness in use; a pack that lists adapters without it is off. */
  readonly harness?: string;
  /** Certified capabilities on this host; missing required ones fall back to advice. */
  readonly capabilities?: ReadonlySet<string>;
  readonly shippedPublishers?: string;
}

/**
 * The packs enabled for a workspace and the mode each runs in (PAK-01, PAK-06, PAK-08, US-C). A
 * tampered pack, an unsupported adapter or an unresolved exclusive conflict turns it off; missing
 * capabilities fall back to advice (or off without a fallback); a refused calibration keeps it at
 * advice; the kill switch holds every pack at observe.
 */
export async function activePacksFor(home: string, workspace: string, context: LoadContext = {}): Promise<readonly LoadedPack[]> {
  const key = await workspaceKey(workspace);
  if (key === null) return [];
  const stopped = await readKillSwitchStopped(home);
  const publishers = await loadPublishers(home, ...(context.shippedPublishers === undefined ? [] : [context.shippedPublishers]));
  const enabled = (await listPackRecords(home)).filter((record) => record.active !== null && record.workspaces[key] !== undefined);
  const ownership = checkPackOwnership(enabled.map((record) => ({ packId: record.id, owns: record.versions[record.active ?? '']?.owns ?? [] })));
  const conflicted = new Set(ownership.ok ? [] : ownership.conflicts.flatMap((item) => item.packs));
  const out: LoadedPack[] = [];
  for (const record of enabled) {
    const version = record.active as string;
    const stage = record.versions[version]?.stage ?? 'draft';
    const installed = await readInstalled(home, record, version);
    if (!installed.ok) {
      out.push({ id: record.id, version, stage, mode: 'off', reasons: [installed.reasonCode], manifest: null, calibration: null, executables: [] });
      continue;
    }
    const { manifest, files } = installed;
    const reasons: string[] = [];
    let mode: LoadedPack['mode'] = manifest.defaultMode;
    if (conflicted.has(record.id)) {
      mode = 'off';
      reasons.push('EXCLUSIVE_CONFLICT');
    }
    if (context.harness !== undefined && manifest.adapters !== undefined && !manifest.adapters.some((item) => item === context.harness)) {
      mode = 'off';
      reasons.push('ADAPTER_UNSUPPORTED');
    }
    if (context.capabilities !== undefined) {
      const has = (list: readonly string[]): boolean => list.every((item) => context.capabilities?.has(item) === true);
      if (!has(manifest.requiresCapabilities)) {
        if (manifest.fallbackCapabilities.length > 0 && has(manifest.fallbackCapabilities)) {
          mode = capMode(mode, 'advise');
          reasons.push('CAPABILITY_FALLBACK');
        } else {
          mode = 'off';
          reasons.push('CAPABILITY_MISSING');
        }
      }
    }
    const calibration = checkCalibrationBindings(manifest, files);
    if (calibration.refused.length > 0) {
      mode = capMode(mode, 'advise');
      reasons.push('CALIBRATION_MISMATCH');
    }
    if (adviseOnly(manifest)) mode = capMode(mode, 'advise');
    if (stopped) {
      mode = capMode(mode, 'observe');
      reasons.push('KILL_SWITCH');
    }
    const executables = mode !== 'off' && signatureStatus(manifest, publishers) === 'verified' ? (manifest.executables ?? []).map((item) => item.id) : [];
    if ((manifest.executables ?? []).length > executables.length) reasons.push('EXECUTABLES_DISABLED');
    out.push({ id: record.id, version, stage, mode, reasons, manifest, calibration, executables });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The manifest file of a shipped or installed pack directory. */
export function manifestPath(dir: string): string {
  return join(dir, PACK_MANIFEST_FILE);
}
