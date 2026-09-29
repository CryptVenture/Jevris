/// <reference path="../types/installer.d.ts" />
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CertificationRecordContract,
  certificationCovers,
  verifyRecordSignature,
  type CertificationCheck,
  type CertificationContext,
  type CertificationRecord,
} from '@jevris/contracts';
import { findPackageRoot, jevrisPaths, writePrivateFile } from '@jevris/platform';
import { applyDemotions, demotionsFor, readLiveEvidence, type Demotion } from './live-evidence.js';

/**
 * Harness certification records (HCF-02, §3.5, §15.4): the one loader every consumer uses.
 *
 * Records live one per file in `<data>/certifications/*.json`. A record counts only when it
 * passes the CertificationRecord contract and its Ed25519 signature verifies against a
 * trusted key:
 * - `release`: a key with role `certification` in the shipped `assets/trust/release-keys.json`.
 * - `local`: the public key `jevris certify` generated in `<data>/certifications/keys/`.
 *   A local record certifies this machine only; the release gates never accept it (they
 *   trust release keys only).
 * Whether a record covers a harness version, OS, time and feature is `certificationCovers`.
 * Anything not covered disables actuation of that feature; observation continues.
 *
 * Evidence from real use (live-evidence.ts): a malformed live event demotes its feature in the
 * record it falls under, until a record certified after it; `record` is then the demoted view
 * every consumer reads, and `signed` the record as signed.
 */

export const CERTIFICATIONS_DIR = 'certifications';
export const LOCAL_KEY_FILE = 'local.key.pem';
export const LOCAL_PUBLIC_FILE = 'local.pub.pem';

/** The shared feature vocabulary lives in @jevris/contracts; re-exported for loader users. */
export { CERTIFICATION_FEATURES, type CertificationFeature } from '@jevris/contracts';

const FILE_CAP = 65536;
const MAX_FILES = 256;

export interface LoadedCertification {
  readonly file: string;
  /** The record with any live demotion applied (what coverage reads). */
  readonly record: CertificationRecord;
  readonly trust: 'release' | 'local';
  readonly keyId: string;
  /** The record exactly as signed, when a demotion changed `record`. */
  readonly signed?: CertificationRecord;
  /** The live demotions applied to `record`. */
  readonly demoted?: readonly Demotion[];
}

export interface RejectedCertification {
  readonly file: string;
  readonly reasonCode: string;
}

export interface CertificationLoad {
  readonly dir: string;
  readonly records: readonly LoadedCertification[];
  readonly rejected: readonly RejectedCertification[];
}

export interface CertificationLoadOptions {
  /** Package root holding assets/trust/release-keys.json. Defaults to this package. */
  readonly root?: string;
  /** Accept records signed by the local certify key. Default true. */
  readonly trustLocal?: boolean;
  readonly platform?: string;
  /** Apply demotions from real use (live-evidence.ts). Default true. */
  readonly liveEvidence?: boolean;
}

export function certificationsDir(home: string, platform?: string): string {
  return join(jevrisPaths({ home, ...(platform === undefined ? {} : { platform }) }).data, CERTIFICATIONS_DIR);
}

function hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `local-<16 hex>` from the SPKI DER of the key, so a key file cannot claim another id. */
export function localKeyId(publicKeyPem: string): string | null {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return `local-${hex(key.export({ type: 'spki', format: 'der' })).slice(0, 16)}`;
  } catch {
    return null;
  }
}

async function readSmall(path: string): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > FILE_CAP) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function releaseKeys(root: string | null): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  if (root === null) return keys;
  const text = await readSmall(join(root, 'assets', 'trust', 'release-keys.json'));
  if (text === null) return keys;
  try {
    const parsed = JSON.parse(text) as { readonly keys?: unknown };
    if (!Array.isArray(parsed.keys)) return keys;
    for (const item of parsed.keys) {
      const key = item as { readonly keyId?: unknown; readonly role?: unknown; readonly publicKeyPem?: unknown };
      if (key.role === 'certification' && typeof key.keyId === 'string' && typeof key.publicKeyPem === 'string') keys.set(key.keyId, key.publicKeyPem);
    }
  } catch {
    return keys;
  }
  return keys;
}

async function localKeys(dir: string): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  const pem = await readSmall(join(dir, 'keys', LOCAL_PUBLIC_FILE));
  if (pem === null) return keys;
  const id = localKeyId(pem);
  if (id !== null) keys.set(id, pem);
  return keys;
}

function defaultRoot(): string | null {
  try {
    return findPackageRoot(import.meta.url);
  } catch {
    return null;
  }
}

/** Loads, validates and signature-checks every record. Never throws; a bad file is listed in `rejected`. */
export async function loadCertifications(home: string, options: CertificationLoadOptions = {}): Promise<CertificationLoad> {
  const dir = certificationsDir(home, options.platform);
  const records: LoadedCertification[] = [];
  const rejected: RejectedCertification[] = [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort().slice(0, MAX_FILES);
  } catch {
    return { dir, records, rejected };
  }
  const release = await releaseKeys(options.root ?? defaultRoot());
  const local = options.trustLocal === false ? new Map<string, string>() : await localKeys(dir);
  for (const name of names) {
    const text = await readSmall(join(dir, name));
    if (text === null) {
      rejected.push({ file: name, reasonCode: 'UNREADABLE' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      rejected.push({ file: name, reasonCode: 'NOT_JSON' });
      continue;
    }
    const checked = CertificationRecordContract.validate(parsed);
    if (!checked.ok) {
      rejected.push({ file: name, reasonCode: 'INVALID' });
      continue;
    }
    const record = checked.value;
    const fromRelease = verifyRecordSignature(record, release);
    if (fromRelease.ok) {
      records.push({ file: name, record, trust: 'release', keyId: fromRelease.keyId });
      continue;
    }
    const fromLocal = verifyRecordSignature(record, local);
    if (fromLocal.ok) {
      records.push({ file: name, record, trust: 'local', keyId: fromLocal.keyId });
      continue;
    }
    rejected.push({ file: name, reasonCode: `SIGNATURE_${fromLocal.reasonCode === 'UNKNOWN_KEY' ? fromRelease.reasonCode : fromLocal.reasonCode}` });
  }
  if (options.liveEvidence === false || records.length === 0) return { dir, records, rejected };
  const { demotions } = await readLiveEvidence(home);
  if (demotions.length === 0) return { dir, records, rejected };
  const demotedRecords = records.map((item) => {
    const applied = demotionsFor(item.record, demotions);
    return applied.length === 0 ? item : { ...item, record: applyDemotions(item.record, applied), signed: item.record, demoted: applied };
  });
  return { dir, records: demotedRecords, rejected };
}

export interface CoverageResult {
  readonly covered: LoadedCertification | null;
  /** The reason of the closest miss when nothing covers; null when covered. */
  readonly reasonCode: Exclude<CertificationCheck, { ok: true }>['reasonCode'] | 'NO_RECORD' | null;
}

/** The first loaded record that certifies this feature here and now (release records first). */
export function coveringCertification(load: CertificationLoad, context: CertificationContext): CoverageResult {
  const ordered = [...load.records].sort((a, b) => (a.trust === b.trust ? 0 : a.trust === 'release' ? -1 : 1));
  let reasonCode: CoverageResult['reasonCode'] = 'NO_RECORD';
  for (const item of ordered) {
    const check = certificationCovers(item.record, context);
    if (check.ok) return { covered: item, reasonCode: null };
    if (item.record.harness === context.harness) reasonCode = check.reasonCode;
  }
  return { covered: null, reasonCode };
}

/** The local certify key pair, created owner-only on first use. */
export async function localSigningKey(home: string, platform?: string): Promise<{ readonly keyId: string; readonly privateKeyPem: string; readonly publicKeyPem: string }> {
  const keys = join(certificationsDir(home, platform), 'keys');
  const privatePath = join(keys, LOCAL_KEY_FILE);
  const publicPath = join(keys, LOCAL_PUBLIC_FILE);
  const existingPrivate = await readSmall(privatePath);
  const existingPublic = await readSmall(publicPath);
  if (existingPrivate !== null && existingPublic !== null) {
    const keyId = localKeyId(existingPublic);
    if (keyId !== null) return { keyId, privateKeyPem: existingPrivate, publicKeyPem: existingPublic };
  }
  await mkdir(keys, { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  await writePrivateFile(privatePath, privateKeyPem);
  await writePrivateFile(publicPath, publicKeyPem);
  const keyId = localKeyId(publicKeyPem);
  if (keyId === null) throw new Error('LOCAL_KEY_INVALID');
  return { keyId, privateKeyPem, publicKeyPem };
}
