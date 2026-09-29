import type { ActuatorRow, DoctorReport, EgressReasonCode, PackReport } from '@jevris/contracts';
import { decideEgress } from '@jevris/core';
import { openWorkspace, testWorkerPortStatus, VERIFICATION_NO_MANIFEST_REASON, verificationSupport } from '@jevris/orchestrator';
import { providerOverrideDiagnostic } from '@jevris/provider-typesafe';
import { probeInstalledHarness, type HarnessProbeRunner } from './harness-probe.js';
import { readInstalledHarnessVersion } from './harness-version.js';
import { classifyEnvironment, type EnvironmentInput } from './platform.js';

/**
 * Capability report. A version string does not certify an actuator.
 * unknown is only a failed read. verification is supported only while the workspace has an
 * approved runner manifest (D's verification service decides; doctor only reports it).
 */

const SAME_USER_LIMIT =
  'A fully compromised OS account is outside what a same-user sidecar can reliably contain; stronger enforcement needs separate principals and operating-system isolation.';

const BYTE_CAP = 131072;

/**
 * worker.route (owned workers that Jevris starts on its own; owner approval 2026-09-26). Certify
 * proves it with no model call (the worker's flags and its nine §15.4 cases), pending first use;
 * `jevris doctor` derives this row from the signed records. This is the row without them.
 */
export const WORKER_ROUTE_REASON = 'worker.route is not certified: no signed record covers an owned worker here; fix: jevris certify --harness all (no model call)';
const PACK_KEYS = [
  'schemaVersion',
  'id',
  'version',
  'maturity',
  'description',
  'requiresCapabilities',
  'fallbackCapabilities',
  'decisionSpecs',
  'actions',
  'dataScopes',
  'defaultMode',
  'conflicts',
  'fixtures',
] as const;
const PACK_KEY_SET = new Set<string>(PACK_KEYS);
const MATURITY = new Set(['experimental', 'canary', 'stable']);
const ACTIONS = new Set([
  'advise',
  'route-worker',
  'request-checkpoint',
  'select-evidence',
  'request-verification',
  'cancel-owned-worker',
  'abstain',
]);
const DATA_SCOPES = new Set([
  'task-metadata',
  'approved-source-spans',
  'approved-tool-output',
  'verification-receipts',
  'policy-metadata',
]);
const MODES = new Set(['off', 'observe', 'advise', 'bounded-auto']);
const ID_PATTERN = /^jevris\.[a-z][a-z0-9.-]+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const ACTUATORS: readonly { readonly id: string; readonly reason: string; readonly platforms?: readonly string[] }[] = [
  { id: 'pretooluse-deny', reason: 'A timed-out command PreToolUse can let the tool proceed.' },
  { id: 'worker.route', reason: WORKER_ROUTE_REASON },
  { id: 'verification', reason: 'verification remains unsupported until an approved runner manifest exists.' },
  // Only Windows has a launcher to certify; elsewhere the row would name a problem that cannot exist.
  { id: 'windows-launcher', reason: 'The certified Windows launcher is not present.', platforms: ['win32'] },
  { id: 'claude.adapter', reason: 'Claude Code stays unsupported until its own conformance record exists; its certification is on the harness claude line.' },
  { id: 'codex.adapter', reason: 'Codex stays unsupported until its own conformance record exists.' },
  { id: 'antigravity.adapter', reason: 'Antigravity stays unsupported until its own conformance record exists; its certification is on the harness antigravity line.' },
  { id: 'opencode.adapter', reason: 'OpenCode stays unsupported until its own conformance record exists.' },
  {
    id: 'kilocode.adapter',
    reason: 'Kilocode plugin is the supported observe adapter. Tool block, model switch, and compaction replacement are not certified.',
  },
];

export interface DoctorInput {
  readonly versionProbe?: () => string | null | Promise<string | null>;
  readonly harnessRunner?: HarnessProbeRunner;
  readonly setting?: unknown;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly inContainer?: boolean;
  readonly packs: readonly unknown[];
  readonly certificationRecords: readonly unknown[];
  readonly fixtureHashes: { readonly [key: string]: string };
  /**
   * ADM-08: the harness adapter rows (claude.adapter, codex.adapter, kilocode.adapter,
   * opencode.adapter, antigravity.adapter) as derived from signed certification records for this host's harness
   * version and OS. A row listed here takes this status and reason instead of the default.
   */
  readonly adapterStatus?: { readonly [id: string]: { readonly certified: boolean; readonly reason: string; readonly fixtureHash: string | null } };
  readonly runnerManifest?: unknown;
  /** The workspace whose approved checks decide verification support. Absent: unsupported. */
  readonly workspace?: { readonly home: string; readonly root: string };
}

const NO_WORKSPACE_REASON = VERIFICATION_NO_MANIFEST_REASON;

function verificationState(input: DoctorInput): { readonly state: 'supported' | 'unsupported'; readonly reason: string } {
  if (input.workspace === undefined) return { state: 'unsupported', reason: NO_WORKSPACE_REASON };
  try {
    // The approval store is on this machine: its paths use the real platform, never the
    // simulated --platform (a win32 report on macOS must not create win32-shaped folders).
    const ws = openWorkspace({ home: input.workspace.home, workspaceRoot: input.workspace.root });
    const support = verificationSupport(ws, input.platform);
    return { state: support.state, reason: support.reason };
  } catch {
    return { state: 'unsupported', reason: 'verification is unsupported: the approval store could not be read.' };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return true;
    }
  }
  return false;
}

function environmentInput(input: DoctorInput): EnvironmentInput {
  const env = input.env ?? {};
  if (input.inContainer === undefined) {
    return { platform: input.platform, nodeVersion: input.nodeVersion, env };
  }
  return { platform: input.platform, nodeVersion: input.nodeVersion, env, inContainer: input.inContainer };
}

async function resolveHarnessVersion(input: DoctorInput): Promise<string> {
  try {
    const probe = input.versionProbe;
    const raw = probe === undefined ? await readInstalledHarnessVersion() : await probe();
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function recordMatches(
  record: unknown,
  actuatorId: string,
  platform: string,
  harnessVersion: string,
  expectedHash: string | undefined,
): boolean {
  if (harnessVersion === 'unknown') return false;
  if (expectedHash === undefined || expectedHash.length === 0) return false;
  if (!isPlainObject(record) || hasDangerousKey(record)) return false;
  return (
    record.actuatorId === actuatorId &&
    record.platform === platform &&
    record.harnessVersion === harnessVersion &&
    record.fixtureHash === expectedHash
  );
}

function actuatorRows(input: DoctorInput, harnessVersion: string, verification: { readonly state: 'supported' | 'unsupported'; readonly reason: string }): readonly ActuatorRow[] {
  return ACTUATORS.filter((row) => row.platforms === undefined || row.platforms.includes(input.platform)).map((row) => {
    const derived = input.adapterStatus?.[row.id];
    if (derived !== undefined) return { id: row.id, status: derived.certified ? ('certified' as const) : ('unsupported' as const), fixtureHash: derived.certified ? derived.fixtureHash : null, reason: derived.reason };
    // The verification actuator follows D's verification service, the same answer as the
    // report's verification line: available while an approved runner manifest exists.
    if (row.id === 'verification' && verification.state === 'supported' && !input.certificationRecords.some((record) => recordMatches(record, row.id, input.platform, harnessVersion, input.fixtureHashes[row.id]))) {
      return { id: row.id, status: 'certified' as const, fixtureHash: null, reason: verification.reason };
    }
    const expected = input.fixtureHashes[row.id];
    const matched = input.certificationRecords.some((record) =>
      recordMatches(record, row.id, input.platform, harnessVersion, expected),
    );
    if (!matched || expected === undefined || expected.length === 0) {
      return { id: row.id, status: 'unsupported' as const, fixtureHash: null, reason: row.reason };
    }
    return { id: row.id, status: 'certified' as const, fixtureHash: expected, reason: row.reason };
  });
}

function utf8ByteLength(value: string): number {
  const Ctor = (globalThis as unknown as {
    TextEncoder?: new () => { encode(input?: string): Uint8Array };
  }).TextEncoder;
  if (Ctor === undefined) return value.length;
  return new Ctor().encode(value).byteLength;
}

function disabledPack(id: string): PackReport {
  return { id, disposition: 'disabled', missingCapabilities: [] };
}

function packId(pack: Record<string, unknown>): string {
  const id = pack.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return 'invalid';
  if (id.includes('\n') || id.includes('\r')) return 'invalid';
  return id;
}

function uniqueStrings(value: unknown, maxLength: number): boolean {
  if (!Array.isArray(value) || value.length > 256) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length < 1 || item.length > maxLength) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function uniqueEnum(value: unknown, allowed: ReadonlySet<string>): boolean {
  if (!Array.isArray(value) || value.length > 256) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function packShapeValid(pack: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(pack);
  if (keys.length !== PACK_KEYS.length) return false;
  for (const key of keys) {
    if (typeof key !== 'string' || !PACK_KEY_SET.has(key)) return false;
  }
  for (const key of PACK_KEYS) {
    if (!Object.hasOwn(pack, key)) return false;
  }
  if (pack.schemaVersion !== '1.0') return false;
  if (typeof pack.id !== 'string' || !ID_PATTERN.test(pack.id)) return false;
  if (typeof pack.version !== 'string' || !VERSION_PATTERN.test(pack.version)) return false;
  if (typeof pack.maturity !== 'string' || !MATURITY.has(pack.maturity)) return false;
  if (typeof pack.description !== 'string' || pack.description.length < 1 || pack.description.length > 1000) {
    return false;
  }
  if (!uniqueStrings(pack.requiresCapabilities, 256)) return false;
  if (!uniqueStrings(pack.fallbackCapabilities, 256)) return false;
  if (!uniqueStrings(pack.decisionSpecs, 256)) return false;
  if (!uniqueEnum(pack.actions, ACTIONS)) return false;
  if (!uniqueEnum(pack.dataScopes, DATA_SCOPES)) return false;
  if (typeof pack.defaultMode !== 'string' || !MODES.has(pack.defaultMode)) return false;
  if (!uniqueStrings(pack.conflicts, 256)) return false;
  if (!uniqueStrings(pack.fixtures, 256)) return false;
  return true;
}

function packReport(pack: unknown, certified: ReadonlySet<string>): PackReport {
  if (typeof pack === 'string') return disabledPack('invalid');
  if (!isPlainObject(pack) || hasDangerousKey(pack)) return disabledPack('invalid');
  const id = packId(pack);
  let encoded = '';
  try {
    const text = JSON.stringify(pack);
    encoded = typeof text === 'string' ? text : '';
  } catch {
    return disabledPack(id);
  }
  if (encoded.length === 0 || utf8ByteLength(encoded) > BYTE_CAP) return disabledPack(id);
  if (!packShapeValid(pack)) return disabledPack(id);
  const required = pack.requiresCapabilities;
  const fallback = pack.fallbackCapabilities;
  if (!Array.isArray(required) || !Array.isArray(fallback)) return disabledPack(id);
  const missing: string[] = [];
  for (const entry of required) {
    if (typeof entry !== 'string' || certified.has(entry)) continue;
    missing.push(entry);
  }
  if (missing.length === 0) return { id, disposition: 'advice', missingCapabilities: [] };
  return {
    id,
    disposition: fallback.length > 0 ? 'advice' : 'disabled',
    missingCapabilities: missing,
  };
}

function packReports(packs: readonly unknown[], actuators: readonly ActuatorRow[]): readonly PackReport[] {
  const certified = new Set<string>();
  for (const row of actuators) {
    if (row.status === 'certified') certified.add(row.id);
  }
  return packs.map((pack) => packReport(pack, certified));
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const harnessVersion = await resolveHarnessVersion(input);
  const harnessProbe = await probeInstalledHarness(
    input.harnessRunner === undefined ? {} : { harnessRunner: input.harnessRunner },
  );
  const egress = Object.hasOwn(input, 'setting') ? decideEgress({ setting: input.setting }) : decideEgress({});
  const classified = classifyEnvironment(environmentInput(input));
  const environmentStatus = harnessVersion === 'unknown' ? 'unsupported' : classified;
  const egressDecision = egress.decision;
  const egressReasonCode: EgressReasonCode | null = egress.decision === 'deny' ? egress.reasonCode : null;
  const verification = verificationState(input);
  const actuators = actuatorRows(input, harnessVersion, verification);
  return {
    schemaVersion: '1.0',
    harnessVersion,
    harnessProbe,
    egressDecision,
    egressReasonCode,
    installStatus: environmentStatus === 'unsupported' ? 'unsupported' : 'reduced',
    environmentStatus,
    verification: verification.state,
    verificationReason: verification.reason,
    actuators,
    packs: packReports(input.packs, actuators),
    sameUserLimit: SAME_USER_LIMIT,
  };
}

/** Why the top block has its state and the one command that fixes it (doctor-cli fills these in). */
export interface DoctorExplain {
  readonly harnessProbe?: string;
  readonly eventProbe?: string;
  readonly installStatus?: string;
}

export const CERTIFY_ALL = 'jevris certify --harness all';

/** The default why-and-fix for each top-block state, used when the caller gives none. */
export function defaultExplain(report: DoctorReport): Required<DoctorExplain> {
  const probe = report.harnessProbe;
  const harnessProbe =
    probe.health === 'certified'
      ? 'every installed harness is certified for the version range its signed record covers'
      : probe.health === 'installation-only'
        ? `Claude Code answers, but no signed record covers its version on this host yet; fix: ${CERTIFY_ALL}`
        : probe.binaryPresent
          ? 'Claude Code did not answer --version and doctor in time; fix: run claude doctor, then jevris doctor'
          : 'Claude Code was not found; the harness lines show the harnesses Jevris found';
  const eventProbe =
    probe.eventProbe === 'passed'
      ? 'certification delivered a live hook event through each installed harness'
      : `no live hook event has been checked on this host yet; fix: ${CERTIFY_ALL}`;
  const installStatus =
    report.installStatus === 'full'
      ? 'every installed harness is certified for its version range and passed its smoke'
      : report.installStatus === 'reduced'
        ? `hooks observe and advise; actuation waits for certification; fix: ${CERTIFY_ALL}`
        : report.installStatus === 'unsupported'
          ? 'the harness version could not be read or this environment is not supported, so Jevris runs rules-only'
          : 'refused';
  return { harnessProbe, eventProbe, installStatus };
}

/**
 * `env`, when given, adds the test provider override line and the scripted test worker port
 * line (the doctor CLI passes its environment and prints each line once). `home` is the Jevris
 * home whose test-home marker the worker port needs. `explain` gives the top block's why and fix.
 */
export function formatDoctor(report: DoctorReport, env?: { readonly [key: string]: string | undefined }, home?: string, explain: DoctorExplain = {}): string {
  const why = { ...defaultExplain(report), ...explain };
  const lines = [
    `harnessVersion: ${report.harnessVersion}`,
    `harnessProbe: ${report.harnessProbe.health} (${why.harnessProbe})`,
    `eventProbe: ${report.harnessProbe.eventProbe} (${why.eventProbe})`,
    `installStatus: ${report.installStatus} (${why.installStatus})`,
    `egressDecision: ${report.egressDecision}`,
  ];
  if (report.egressReasonCode !== null) {
    lines.push(`egressReasonCode: ${report.egressReasonCode}`);
  }
  for (const row of report.actuators) {
    lines.push(`actuator ${row.id}: ${row.status}`);
    lines.push(row.reason);
  }
  if (report.environmentStatus === 'reduced') {
    lines.push('UI localhost is not the worker.');
  }
  lines.push(`verification: ${report.verification}`);
  lines.push(report.verificationReason);
  for (const pack of report.packs) {
    lines.push(`pack ${pack.id}: ${pack.disposition}`);
  }
  const override = env === undefined ? null : providerOverrideDiagnostic(env);
  if (override !== null) lines.push(override);
  const testWorker = env === undefined ? null : testWorkerPortStatus(env, home).diagnostic;
  if (testWorker !== null) lines.push(testWorker);
  lines.push(report.sameUserLimit);
  lines.push(`JEVRIS_REPORT ${JSON.stringify(report)}`);
  return `${lines.join('\n')}\n`;
}
