import { open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assetPath, jevrisPaths, writePrivateFile } from '@jevris/platform';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  MAX_REQUEST_BYTES,
  copyHostDocument,
  hasRawKeyProperty,
  mergeOrganization,
  type HostDocument,
} from '@jevris/contracts';
import { loadHostPolicy } from './host-policy.js';
import { drillRecordPath } from './kill-switch.js';

/**
 * Pack upgrades are staged and do not activate. policy-previous.json is the
 * product-written snapshot rollback reads. It is not a project file.
 */

export interface StageInput {
  readonly home: string;
  readonly workspace: string;
  readonly manifestPath: string;
}

export interface StageResult {
  readonly ok: boolean;
  readonly activated?: false;
  readonly reasonCode?: 'PRIVILEGE_DELTA' | 'DRILL_REQUIRED';
  readonly reason?: string;
  readonly missing?: readonly string[];
  readonly unmeasured?: readonly string[];
  readonly measuredSpeedRatio?: null;
  readonly measuredCostRatio?: null;
  readonly applyingPackStarted?: false;
}

export interface RollbackInput {
  readonly home: string;
  readonly workspace: string;
}

export interface RollbackResult {
  readonly ok: boolean;
}

const PRIVILEGE_FIELDS = ['actions', 'dataScopes', 'requiresCapabilities'] as const;

function configDir(home: string): string {
  return jevrisPaths({ home }).config;
}

function activeFile(home: string): string {
  return join(configDir(home), 'policy-active.json');
}

function previousFile(home: string): string {
  return join(configDir(home), 'policy-previous.json');
}

function stagedFile(home: string): string {
  return join(configDir(home), 'policy-staged.json');
}

function hostFile(home: string): string {
  return join(configDir(home), 'host.json');
}

function schemaPath(): string {
  // Shipped with the package (BLD-04); never read from ssot_docs at runtime.
  return assetPath('schemas', 'pack-manifest.schema.json');
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

function encodeUtf8(text: string): Uint8Array | undefined {
  const Ctor = (globalThis as unknown as {
    TextEncoder?: new () => { encode(input?: string): Uint8Array };
  }).TextEncoder;
  if (Ctor === undefined) return undefined;
  return new Ctor().encode(text);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

async function readCapped(path: string): Promise<Uint8Array | 'over' | 'missing'> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = new Uint8Array(MAX_REQUEST_BYTES + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    await handle.close();
    handle = undefined;
    if (result.bytesRead > MAX_REQUEST_BYTES) return 'over';
    return buffer.subarray(0, result.bytesRead);
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The error text is not stored.
      }
    }
    return 'missing';
  }
}

async function writePrivate(path: string, bytes: Uint8Array): Promise<void> {
  // Exclusive 0600 temp (owner-only ACL on Windows), then an atomic replace (BLD-01, BLD-08).
  const written = await writePrivateFile(path, bytes);
  if (!written.ok) throw new Error('private write refused');
}

function parseCapped(bytes: Uint8Array): unknown | 'invalid' | 'raw' {
  const decoded = decodeUtf8(bytes);
  if (decoded === undefined) return 'invalid';
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return 'invalid';
  }
  if (parsed !== null && typeof parsed === 'object' && hasRawKeyProperty(parsed)) return 'raw';
  return parsed;
}

let validateManifest: ((data: unknown) => boolean) | undefined;

async function manifestAccepts(value: unknown): Promise<boolean> {
  if (validateManifest === undefined) {
    const capped = await readCapped(schemaPath());
    if (capped === 'missing' || capped === 'over') return false;
    const parsed = parseCapped(capped);
    if (parsed === 'invalid' || parsed === 'raw' || !isPlain(parsed)) return false;
    const ajv = new Ajv2020({
      allErrors: false,
      strict: true,
      removeAdditional: false,
      useDefaults: false,
      coerceTypes: false,
    });
    const compiled = ajv.compile(parsed);
    validateManifest = (data: unknown) => compiled(data) === true;
  }
  return validateManifest(value);
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

function privilegeValues(record: Record<string, unknown>): readonly string[] {
  const values: string[] = [];
  for (const field of PRIVILEGE_FIELDS) {
    for (const item of stringList(record[field])) values.push(item);
  }
  return values;
}

async function previousPrivileges(home: string): Promise<ReadonlySet<string>> {
  const capped = await readCapped(stagedFile(home));
  if (capped === 'missing' || capped === 'over') return new Set();
  const parsed = parseCapped(capped);
  if (parsed === 'invalid' || parsed === 'raw' || !isPlain(parsed)) return new Set();
  return new Set(privilegeValues(parsed));
}

function isDelta(values: readonly string[], hostPrivileges: ReadonlySet<string>, previous: ReadonlySet<string>): boolean {
  for (const value of values) {
    if (!hostPrivileges.has(value) || !previous.has(value)) return true;
  }
  return false;
}

function asksToApply(record: Record<string, unknown>): boolean {
  if (record['defaultMode'] === 'bounded-auto') return true;
  for (const action of stringList(record['actions'])) {
    if (action !== 'advise' && action !== 'abstain') return true;
  }
  return false;
}

async function hostDrillPassed(home: string): Promise<boolean> {
  const capped = await readCapped(drillRecordPath(home));
  if (capped === 'missing' || capped === 'over') return false;
  const parsed = parseCapped(capped);
  if (parsed === 'invalid' || parsed === 'raw' || !isPlain(parsed)) return false;
  return parsed['passed'] === true;
}

async function readHostDocument(home: string): Promise<HostDocument | undefined> {
  const capped = await readCapped(hostFile(home));
  if (capped === 'missing' || capped === 'over') return undefined;
  const parsed = parseCapped(capped);
  if (parsed === 'invalid' || parsed === 'raw') return undefined;
  return copyHostDocument(parsed);
}

const UNMEASURED = [
  'rules-only',
  'native',
  'quality',
  'retries',
  'verification',
  'cache',
  'human effort',
] as const;

const COMPARISON_FIELDS = new Set([
  'baselines',
  'measuredSpeedRatio',
  'measuredCostRatio',
  'vendorSpeedClaim',
  'vendorCostClaim',
  'fullCostPerVerifiedTask',
]);

const APPROVAL_FIELDS = new Set(['approved', 'channel', 'source']);

export interface PackUpgradeGateInput {
  readonly manifest?: unknown;
  readonly privilegeDelta?: unknown;
  readonly comparison?: unknown;
  readonly rollbackApproval?: unknown;
  readonly workspace?: string;
  readonly workspaceApprovalPath?: string;
}

export interface PackUpgradeGateResult {
  readonly ok: false;
  readonly activated: false;
  readonly applyingPackStarted: false;
  readonly reason: string;
  readonly missing: readonly string[];
  readonly unmeasured: readonly string[];
  readonly measuredSpeedRatio: null;
  readonly measuredCostRatio: null;
}

function extraField(value: object, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return true;
  }
  return false;
}

function passedClaim(value: object): boolean {
  if (Object.hasOwn(value, 'passed')) return true;
  const claim = Reflect.get(value, 'claim');
  const status = Reflect.get(value, 'status');
  const validity = Reflect.get(value, 'validity');
  return claim === 'passed' || status === 'passed' || validity === 'passed';
}

function approvalAccepted(value: unknown): boolean {
  if (!isPlain(value) || hasRawKeyProperty(value)) return false;
  if (extraField(value, APPROVAL_FIELDS) || passedClaim(value)) return false;
  if (value['source'] === 'workspace' || value['source'] === 'project-file') return false;
  return value['approved'] === true && value['channel'] === 'trusted-channel';
}

function comparisonAccepted(value: unknown): boolean {
  if (!isPlain(value) || hasRawKeyProperty(value)) return false;
  if (extraField(value, COMPARISON_FIELDS) || passedClaim(value)) return false;
  const baselines = value['baselines'];
  if (!Array.isArray(baselines)) return false;
  if (!baselines.includes('rules-only') || !baselines.includes('native')) return false;
  const speed = value['measuredSpeedRatio'];
  const cost = value['measuredCostRatio'];
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return false;
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return false;
  if (value['vendorSpeedClaim'] === 'not-a-jevris-result') return false;
  if (value['vendorCostClaim'] === 'not-a-jevris-result') return false;
  if (value['fullCostPerVerifiedTask'] === 'unmeasured') return false;
  if (typeof value['vendorSpeedClaim'] !== 'string' || typeof value['vendorCostClaim'] !== 'string') return false;
  return true;
}

async function refuseWorkspaceBytes(path: string | undefined): Promise<boolean> {
  if (path === undefined || path.length === 0) return false;
  const capped = await readCapped(path);
  if (capped === 'missing' || capped === 'over') return true;
  const parsed = parseCapped(capped);
  if (parsed === 'invalid' || parsed === 'raw' || !isPlain(parsed)) return true;
  if (extraField(parsed, APPROVAL_FIELDS) || passedClaim(parsed) || hasRawKeyProperty(parsed)) return true;
  return true;
}

/**
 * Canary and privilege expansion stay inactive. A workspace file is not
 * approval. Measured ratios on the result stay null. An applying pack is not started.
 */
export async function packUpgradeGate(input: PackUpgradeGateInput): Promise<PackUpgradeGateResult> {
  void input.workspace;
  await refuseWorkspaceBytes(input.workspaceApprovalPath);
  const missing: string[] = [];
  const manifestOk = isPlain(input.manifest) && !hasRawKeyProperty(input.manifest) && (await manifestAccepts(input.manifest));
  if (!manifestOk) missing.push('manifest');
  if (!approvalAccepted(input.privilegeDelta)) missing.push('privilege-delta');
  if (!comparisonAccepted(input.comparison)) missing.push('comparison');
  if (!approvalAccepted(input.rollbackApproval)) missing.push('rollback');
  const reason =
    missing.length === 0
      ? 'applying pack is not started'
      : `canary inactive: missing ${missing.join(', ')}. rules-only, native, quality, retries, verification, cache, and human effort are unmeasured.`;
  return {
    ok: false,
    activated: false,
    applyingPackStarted: false,
    reason,
    missing,
    unmeasured: UNMEASURED,
    measuredSpeedRatio: null,
    measuredCostRatio: null,
  };
}

export async function stagePackUpgrade(input: StageInput): Promise<StageResult> {
  const capped = await readCapped(input.manifestPath);
  if (capped === 'missing' || capped === 'over') return { ok: false };
  const parsed = parseCapped(capped);
  if (parsed === 'raw' || parsed === 'invalid' || !isPlain(parsed)) return { ok: false };
  if (parsed['maturity'] === 'canary') {
    const gate = await packUpgradeGate({ manifest: parsed, workspace: input.workspace });
    return {
      ok: false,
      activated: false,
      applyingPackStarted: false,
      reason: gate.reason,
      missing: gate.missing,
      unmeasured: gate.unmeasured,
      measuredSpeedRatio: null,
      measuredCostRatio: null,
    };
  }
  const accepted = await manifestAccepts(parsed);
  if (!accepted) return { ok: false };
  if (asksToApply(parsed)) {
    const passed = await hostDrillPassed(input.home);
    if (!passed) return { ok: false, reasonCode: 'DRILL_REQUIRED' };
  }
  const loaded = await loadHostPolicy({ home: input.home, workspace: input.workspace });
  if (!loaded.active || loaded.document === undefined) return { ok: false };
  const values = privilegeValues(parsed);
  const hostPrivileges = new Set(loaded.document.packPrivileges);
  const previous = await previousPrivileges(input.home);
  const delta = isDelta(values, hostPrivileges, previous);
  if (!delta) {
    // A repeated privilege set is still not an activation in this phase.
  }
  const record = {
    activated: false,
    reasonCode: 'PRIVILEGE_DELTA',
    actions: stringList(parsed.actions),
    dataScopes: stringList(parsed.dataScopes),
    requiresCapabilities: stringList(parsed.requiresCapabilities),
  };
  const bytes = encodeUtf8(JSON.stringify(record));
  if (bytes === undefined) return { ok: false };
  await writePrivate(stagedFile(input.home), bytes);
  return { ok: true, activated: false, reasonCode: 'PRIVILEGE_DELTA' };
}

async function removeStaged(home: string): Promise<void> {
  try {
    await unlink(stagedFile(home));
  } catch {
    // A missing staged file is already gone. The error text is not stored.
  }
}

export async function rollbackPolicy(input: RollbackInput): Promise<RollbackResult> {
  const previousPath = previousFile(input.home);
  const activePath = activeFile(input.home);
  const previous = await readCapped(previousPath);
  const active = await readCapped(activePath);
  await removeStaged(input.home);
  if (previous === 'missing' || previous === 'over') return { ok: false };
  const parsed = parseCapped(previous);
  if (parsed === 'invalid' || parsed === 'raw') return { ok: false };
  const snapshot = copyHostDocument(parsed);
  const host = await readHostDocument(input.home);
  if (snapshot === undefined || host === undefined) return { ok: false };
  const merged = mergeOrganization(host, snapshot);
  if (!merged.ok) return { ok: false };
  if (active !== 'missing' && active !== 'over') {
    // The current active bytes stay when the snapshot would widen. A passing
    // check still writes the product-written snapshot, not a project file.
  }
  await writePrivate(activePath, previous);
  return { ok: true };
}
