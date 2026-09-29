import { lstat, open, readFile, realpath, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { decideEgress } from '@jevris/core';
import {
  MAX_REQUEST_BYTES,
  applyProjectNarrowing,
  copyHostDocument,
  hasRawKeyProperty,
  mergeOrganization,
  type HostDocument,
  type HostEgress,
} from '@jevris/contracts';
import { PRIVATE_FILE_MODE, applyOwnerOnlyAcl, durableWrite, ensurePrivateDir, jevrisPaths, resolveHome, writePrivateFile } from '@jevris/platform';
import type { OpenHostSecret } from './credential.js';
import { readManagedPolicy } from './enterprise-policy.js';

/**
 * Host policy lives outside the workspace. Provenance is assigned here,
 * after the realpath check, and is never copied from a file.
 */

export interface HostGateInput {
  readonly provenance: 'administrator';
  readonly sourceEgress: HostEgress;
}

export interface LoadHostPolicyInput {
  readonly home: string;
  readonly workspace: string;
  readonly project?: string;
}

export type HostPolicyReason = 'RAW_KEY_REFUSED' | 'POLICY_WIDEN' | 'MANAGED_POLICY_REFUSED';

export interface LoadedHostPolicy {
  readonly active: boolean;
  readonly provenance?: 'administrator';
  /**
   * Where the policy in force comes from (GOV-05): the administrator's managed location, with
   * the user's host.json only narrowing it (`managed`), or the host.json in the user's config
   * directory (`host`).
   */
  readonly source?: 'managed' | 'host';
  readonly document?: HostDocument;
  readonly gate?: HostGateInput;
  readonly reasonCode?: HostPolicyReason;
}

export interface ScreenInput {
  readonly home: string;
  readonly workspace: string;
  readonly project?: string;
  readonly wouldSendSource: boolean;
  readonly fetch?: () => unknown;
  readonly openKeyring?: OpenHostSecret;
  readonly readEnv?: (name: string) => string | undefined;
}

export interface ScreenResult {
  readonly explanation: string;
  readonly sent: false;
  readonly providerCalls: 0;
  readonly decision: 'deny' | 'allow';
  readonly gate?: HostGateInput;
  readonly reasonCode?: HostPolicyReason;
  readonly installerEnvName?: string;
}

function configDir(home: string): string {
  return jevrisPaths({ home }).config;
}

function hostFile(home: string): string {
  return join(configDir(home), 'host.json');
}

function organizationFile(home: string): string {
  return join(configDir(home), 'organization.json');
}

function activeFile(home: string): string {
  return join(configDir(home), 'policy-active.json');
}

function previousFile(home: string): string {
  return join(configDir(home), 'policy-previous.json');
}

function inactive(reasonCode?: HostPolicyReason): LoadedHostPolicy {
  if (reasonCode === undefined) return { active: false };
  return { active: false, reasonCode };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
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

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

async function hostIsOutside(path: string, workspace: string): Promise<boolean> {
  try {
    const hostReal = await realpath(path);
    const rootReal = await realpath(workspace);
    return !isInside(rootReal, hostReal);
  } catch {
    return false;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function writePrivate(path: string, bytes: Uint8Array): Promise<void> {
  // Exclusive 0600 temp (owner-only ACL on Windows), then an atomic replace (BLD-01, BLD-08).
  const written = await writePrivateFile(path, bytes);
  if (!written.ok) throw new Error('private write refused');
}

function documentBytes(document: HostDocument): Uint8Array | undefined {
  const text = JSON.stringify({
    schemaVersion: document.schemaVersion,
    mode: document.mode,
    egress: document.egress,
    retention: {
      rawArtifactRetentionDays: document.retention.rawArtifactRetentionDays,
      decisionRetentionDays: document.retention.decisionRetentionDays,
    },
    budget: { maxRequestBytes: document.budget.maxRequestBytes },
    pin: { model: document.pin.model, respectHumanPins: true },
    packPrivileges: [...document.packPrivileges],
    credentialRef: document.credentialRef,
    installerEnvName: document.installerEnvName,
    allowUncalibratedActuation: false,
  });
  return encodeUtf8(text);
}

async function replaceActive(home: string, bytes: Uint8Array): Promise<boolean> {
  const active = activeFile(home);
  const previous = previousFile(home);
  let current: Uint8Array | undefined;
  try {
    current = await readFile(active);
  } catch {
    current = undefined;
  }
  if (current !== undefined && !sameBytes(current, bytes)) {
    await writePrivate(previous, current);
  }
  await writePrivate(active, bytes);
  return true;
}

function gateFor(document: HostDocument): HostGateInput {
  return {
    provenance: 'administrator',
    sourceEgress: document.egress,
  };
}

type ReadKind = 'missing' | 'over' | 'invalid' | 'raw' | 'value';

async function readConfig(path: string): Promise<{ readonly kind: ReadKind; readonly value?: unknown }> {
  const capped = await readCapped(path);
  if (capped === 'missing') return { kind: 'missing' };
  if (capped === 'over') return { kind: 'over' };
  const parsed = parseCapped(capped);
  if (parsed === 'raw') return { kind: 'raw' };
  if (parsed === 'invalid') return { kind: 'invalid' };
  return { kind: 'value', value: parsed };
}

function activeResult(
  document: HostDocument,
  gateDocument: HostDocument,
  source: 'managed' | 'host',
  reasonCode?: HostPolicyReason,
): LoadedHostPolicy {
  return {
    active: true,
    provenance: 'administrator',
    source,
    document,
    gate: gateFor(gateDocument),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  };
}

/** The host's source-egress decision, as the provider transport's egress guard makes it. */
export type HostEgressDecision = 'approved' | 'not-approved';

/**
 * The egress guard's own decision (B's `resolveSourceEgress` from `@jevris/sidecar`) over
 * host.json, organization.json and a managed policy. When the resolver cannot load or throws,
 * egress is not approved: the guard would not approve either, and a user file never does.
 */
export async function resolveHostSourceEgress(home: string): Promise<HostEgressDecision> {
  try {
    const sidecar = await import('@jevris/sidecar');
    return sidecar.resolveSourceEgress({ home }) === 'approved' ? 'approved' : 'not-approved';
  } catch {
    return 'not-approved';
  }
}

export async function loadHostPolicy(input: LoadHostPolicyInput): Promise<LoadedHostPolicy> {
  // GOV-05: a managed policy from the administrator's location is the base; a refused one
  // (not admin-owned, writable by others, invalid) leaves the policy inactive, so egress stays
  // denied. The user's host.json then carries provenance `user` and may only narrow it.
  const managed = readManagedPolicy();
  if (managed.state === 'refused') return inactive('MANAGED_POLICY_REFUSED');
  const path = hostFile(input.home);
  const hostRead = await readConfig(path);
  let stored: HostDocument;
  let reasonCode: HostPolicyReason | undefined;
  let blockWrite = false;
  if (managed.state === 'ok') {
    stored = managed.document;
    if (hostRead.kind === 'raw') {
      reasonCode = 'RAW_KEY_REFUSED';
      blockWrite = true;
    } else if (hostRead.kind === 'value' && isPlain(hostRead.value) && (await hostIsOutside(path, input.workspace))) {
      const userHost = copyHostDocument(hostRead.value);
      if (userHost !== undefined) {
        const narrowed = mergeOrganization(stored, userHost);
        if (narrowed.ok) stored = narrowed.document;
        else reasonCode = 'POLICY_WIDEN';
      }
    }
  } else {
    if (hostRead.kind === 'raw') return inactive('RAW_KEY_REFUSED');
    if (hostRead.kind !== 'value' || !isPlain(hostRead.value)) return inactive();
    const outside = await hostIsOutside(path, input.workspace);
    if (!outside) return inactive();
    const hostDocument = copyHostDocument(hostRead.value);
    if (hostDocument === undefined) return inactive();
    stored = hostDocument;
  }
  const organization = await readConfig(organizationFile(input.home));
  if (organization.kind === 'raw') {
    reasonCode = 'RAW_KEY_REFUSED';
    blockWrite = true;
  } else if (organization.kind === 'value') {
    const organizationDocument = copyHostDocument(organization.value);
    if (organizationDocument !== undefined) {
      const merged = mergeOrganization(stored, organizationDocument);
      if (!merged.ok) {
        reasonCode = 'POLICY_WIDEN';
        blockWrite = true;
      } else {
        stored = merged.document;
      }
    }
  }

  let memory = stored;
  if (input.project !== undefined) {
    const project = await readConfig(input.project);
    if (project.kind === 'raw') {
      reasonCode = 'RAW_KEY_REFUSED';
      blockWrite = true;
    } else if (project.kind === 'value') {
      const narrowed = applyProjectNarrowing(memory, project.value);
      if (!narrowed.ok) {
        if (narrowed.reasonCode === 'RAW_KEY_REFUSED') {
          reasonCode = 'RAW_KEY_REFUSED';
          blockWrite = true;
        } else if (reasonCode !== 'RAW_KEY_REFUSED') {
          reasonCode = 'POLICY_WIDEN';
        }
      } else {
        memory = narrowed.document;
      }
    }
  }

  if (!blockWrite) {
    const bytes = documentBytes(stored);
    if (bytes === undefined) return inactive();
    await replaceActive(input.home, bytes);
  }
  return activeResult(memory, stored, managed.state === 'ok' ? 'managed' : 'host', reasonCode);
}

function screened(loaded: LoadedHostPolicy, decision: 'deny' | 'allow', explanation: string): ScreenResult {
  return {
    explanation,
    sent: false,
    providerCalls: 0,
    decision,
    ...(loaded.gate !== undefined ? { gate: loaded.gate } : {}),
    ...(loaded.reasonCode !== undefined ? { reasonCode: loaded.reasonCode } : {}),
    ...(loaded.document !== undefined ? { installerEnvName: loaded.document.installerEnvName } : {}),
  };
}

/**
 * JEV-0024: what `jevris policy check --would-send-source` says when the gate allows egress. It
 * must be non-empty: the command treats an empty explanation as a refusal, and an approved
 * workspace used to be reported as "refused" (exit 2) for that reason.
 */
export const EGRESS_ALLOWED = 'Egress allowed: source egress is approved for this workspace. Nothing was sent; each request is still screened for secrets and size caps before it leaves the machine.';

export async function screenSemanticDecision(input: ScreenInput): Promise<ScreenResult> {
  const loaded = await loadHostPolicy({
    home: input.home,
    workspace: input.workspace,
    ...(input.project !== undefined ? { project: input.project } : {}),
  });
  if (loaded.reasonCode === 'RAW_KEY_REFUSED') {
    return screened(loaded, 'deny', '');
  }
  if (!loaded.active || loaded.gate === undefined) {
    const decision = decideEgress({ untrustedClaims: [] });
    const explanation = decision.decision === 'deny' ? decision.explanation : '';
    return screened({ active: false }, 'deny', explanation);
  }
  const decision = decideEgress({
    setting: loaded.gate,
    untrustedClaims: [],
  });
  if (decision.decision === 'deny') {
    return screened(loaded, 'deny', decision.explanation);
  }
  return screened(loaded, 'allow', EGRESS_ALLOWED);
}


// ------------------------------------------------------------ output paths (GOV-11)

/**
 * Where a command may write a file the user asked for (`gates --out`, `shadow --out` and the
 * other output options). SSOT §16.1 "Path escape": canonical containment and race-aware checks.
 *
 * - The path (relative to the working directory) must fall inside an approved root: the working
 *   directory, the user's home directory or the system temp directory, unless `roots` says
 *   otherwise. A root may itself be reached through a link (macOS /tmp, a symlinked checkout);
 *   below the root no component may be a symlink or a Windows junction.
 * - Never inside Jevris's own private directories (config, data, state, runtime), a `.git`
 *   directory, or `.ssh` / `.gnupg`.
 * - The path returned (and written) is under the root's real location.
 * - The target may be new or an existing regular file. It is replaced atomically from an
 *   exclusive owner-only temp (0600, owner-only ACL on Windows), so a link or hard link planted at
 *   the target is replaced, never written through. Missing directories below the root are created
 *   owner-only, one at a time, each checked as it is made. An existing directory is left as it is.
 */
export interface OutputPathOptions {
  /** The invoking working directory. Default process.cwd(). */
  readonly cwd?: string;
  /** The approved roots. Default [cwd, the user's home, the system temp directory]. */
  readonly roots?: readonly string[];
  /** The Jevris home (--home); its private directories are refused. Default JEVRIS_HOME or the OS home. */
  readonly jevrisHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type OutputPathRefusal =
  | 'OUTPUT_PATH_INVALID'
  | 'OUTPUT_OUTSIDE_ROOTS'
  | 'OUTPUT_PRIVATE_DIR'
  | 'OUTPUT_SYMLINK'
  | 'OUTPUT_NOT_DIRECTORY'
  | 'OUTPUT_NOT_FILE'
  | 'OUTPUT_WRITE_FAILED';

export type ConfinedOutput =
  | { readonly ok: true; readonly path: string; readonly root: string; readonly missing: readonly string[] }
  | { readonly ok: false; readonly reasonCode: OutputPathRefusal };

const MAX_OUTPUT_PATH = 4096;
const REFUSED_SEGMENTS = new Set(['.git', '.ssh', '.gnupg']);

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function within(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel;
}

/** Checks an output path against the approved roots; nothing is created. */
export async function confineOutputPath(path: string, options: OutputPathOptions = {}): Promise<ConfinedOutput> {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_OUTPUT_PATH || path.includes('\0')) {
    return { ok: false, reasonCode: 'OUTPUT_PATH_INVALID' };
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const absolute = resolve(cwd, path);
  // The user's home (not JEVRIS_HOME): an empty environment makes resolveHome answer the OS home.
  const roots = options.roots ?? [cwd, resolveHome({ env: {} }).home, tmpdir()];

  // Jevris's own private directories, by their given and their real location.
  const paths = jevrisPaths({ ...(options.jevrisHome !== undefined ? { home: options.jevrisHome } : {}), ...(options.env !== undefined ? { env: options.env } : {}) });
  const privateDirs = [paths.config, paths.data, paths.state, paths.runtime, paths.legacyConfig, paths.legacyData];
  const realTarget = join(await realOrSelf(dirname(absolute)), basename(absolute));
  for (const dir of privateDirs) {
    if (within(dir, absolute) !== undefined || within(await realOrSelf(dir), realTarget) !== undefined) {
      return { ok: false, reasonCode: 'OUTPUT_PRIVATE_DIR' };
    }
  }

  for (const root of roots) {
    const given = resolve(root);
    // A filesystem root (/, C:\) as the working directory approves nothing.
    if (dirname(given) === given) continue;
    const real = await realOrSelf(given);
    for (const prefix of given === real ? [given] : [given, real]) {
      const rel = within(prefix, absolute);
      if (rel === undefined) continue;
      const segments = rel.split(sep).filter((segment) => segment.length > 0);
      if (segments.some((segment) => REFUSED_SEGMENTS.has(segment.toLowerCase()))) {
        return { ok: false, reasonCode: 'OUTPUT_PRIVATE_DIR' };
      }
      // Walk down from the root: no link below it, directories on the way, a file (or nothing) at the end.
      // Everything below is checked, and written, from the root's real location.
      const target = join(real, ...segments);
      let current = real;
      const missing: string[] = [];
      for (let index = 0; index < segments.length; index += 1) {
        current = join(current, segments[index] as string);
        if (missing.length > 0) {
          missing.push(current);
          continue;
        }
        let st;
        try {
          st = await lstat(current);
        } catch {
          if (index < segments.length - 1) missing.push(current);
          continue;
        }
        if (st.isSymbolicLink()) return { ok: false, reasonCode: 'OUTPUT_SYMLINK' };
        const last = index === segments.length - 1;
        if (!last && !st.isDirectory()) return { ok: false, reasonCode: 'OUTPUT_NOT_DIRECTORY' };
        if (last && !st.isFile()) return { ok: false, reasonCode: 'OUTPUT_NOT_FILE' };
      }
      // The final segment is the file, never a directory to create.
      if (missing.length > 0 && missing[missing.length - 1] === target) missing.pop();
      return { ok: true, path: target, root: real, missing };
    }
  }
  return { ok: false, reasonCode: 'OUTPUT_OUTSIDE_ROOTS' };
}

/**
 * Writes an output file the user asked for, confined as confineOutputPath describes. Returns the
 * absolute path written, or the reason it was refused. Nothing is written on a refusal.
 */
export async function writeConfinedOutput(
  path: string,
  data: Uint8Array | string,
  options: OutputPathOptions = {},
): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly reasonCode: OutputPathRefusal }> {
  const confined = await confineOutputPath(path, options);
  if (!confined.ok) return confined;
  for (const dir of confined.missing) {
    const made = await ensurePrivateDir(dir);
    if (!made.ok) return { ok: false, reasonCode: made.code === 'ESYMLINK' ? 'OUTPUT_SYMLINK' : 'OUTPUT_WRITE_FAILED' };
  }
  // Checked again now that the directories exist: a link planted meanwhile is refused.
  const again = await confineOutputPath(confined.path, { ...options, roots: [confined.root] });
  if (!again.ok) return again;
  const written = await durableWrite(confined.path, data, {
    mode: PRIVATE_FILE_MODE,
    ...(process.platform === 'win32' ? { beforeRename: (temp: string) => applyOwnerOnlyAcl(temp, false) } : {}),
  });
  if (!written.ok) return { ok: false, reasonCode: written.code === 'ESYMLINK' ? 'OUTPUT_SYMLINK' : 'OUTPUT_WRITE_FAILED' };
  return { ok: true, path: confined.path };
}
