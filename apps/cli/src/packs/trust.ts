/**
 * Pack provenance (PAK-03, §11.1, §16.1 C56): an Ed25519 signature over the manifest, a
 * publisher allowlist, and file pins.
 *
 * - The signature covers the canonical manifest without its `signature` field. The manifest pins
 *   every file of the pack by sha256 (`files`), so the signature covers executables, fixtures and
 *   calibration artifacts too.
 * - A publisher is trusted only when it is on the allowlist: the shipped list
 *   (`assets/trust/pack-publishers.json`, changed only by a reviewed commit) plus the local list
 *   (`<config>/pack-publishers.json`, written only by `jevris pack publisher add` after a human
 *   confirmation). The signing key must be one of that publisher's keys.
 * - A signature identifies a publisher; it does not prove a pack is safe (§11.1). Unsigned or
 *   unlisted packs may still activate declarative behavior after their delta is approved, but
 *   never an executable component.
 */
import { readFile } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import { assetPath, jevrisPaths, writePrivateFile } from '@jevris/platform';
import { verifyRecordSignature } from '@jevris/contracts';
import type { PackManifest } from './manifest.js';

export interface PublisherKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface PackPublisher {
  readonly id: string;
  readonly keys: readonly PublisherKey[];
  readonly source: 'shipped' | 'local';
}

export type SignatureStatus = 'verified' | 'unsigned' | 'unlisted-publisher' | 'unknown-key' | 'bad-signature';

const PUBLISHER_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PUBLISHERS = 256;

export function localPublishersPath(home: string): string {
  return join(jevrisPaths({ home }).config, 'pack-publishers.json');
}

function isEd25519(pem: string): boolean {
  try {
    return createPublicKey(pem).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function parsePublishers(text: string, source: PackPublisher['source']): PackPublisher[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { readonly publishers?: unknown } | null)?.publishers;
  if (!Array.isArray(list)) return [];
  const out: PackPublisher[] = [];
  for (const entry of list.slice(0, MAX_PUBLISHERS)) {
    const item = entry as { readonly id?: unknown; readonly keys?: unknown };
    if (typeof item.id !== 'string' || !PUBLISHER_ID.test(item.id) || !Array.isArray(item.keys)) continue;
    const keys: PublisherKey[] = [];
    for (const key of item.keys.slice(0, 16)) {
      const k = key as { readonly keyId?: unknown; readonly publicKeyPem?: unknown };
      // A malformed key is skipped, never trusted.
      if (typeof k.keyId === 'string' && KEY_ID.test(k.keyId) && typeof k.publicKeyPem === 'string' && isEd25519(k.publicKeyPem)) keys.push({ keyId: k.keyId, publicKeyPem: k.publicKeyPem });
    }
    if (keys.length > 0) out.push({ id: item.id, keys, source });
  }
  return out;
}

async function readText(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > 1_048_576 ? null : text;
  } catch {
    return null;
  }
}

/** The allowlist: shipped publishers, then local ones. */
export async function loadPublishers(home: string, shippedPath: string = assetPath('trust', 'pack-publishers.json')): Promise<readonly PackPublisher[]> {
  const shipped = await readText(shippedPath);
  const local = await readText(localPublishersPath(home));
  return [...(shipped === null ? [] : parsePublishers(shipped, 'shipped')), ...(local === null ? [] : parsePublishers(local, 'local'))];
}

/** Verifies the manifest's signature against the allowlist. */
export function signatureStatus(manifest: PackManifest, publishers: readonly PackPublisher[]): SignatureStatus {
  if (manifest.signature === undefined) return 'unsigned';
  const keys = new Map<string, string>();
  for (const publisher of publishers) {
    if (publisher.id !== manifest.publisher) continue;
    for (const key of publisher.keys) keys.set(key.keyId, key.publicKeyPem);
  }
  if (keys.size === 0) return 'unlisted-publisher';
  const checked = verifyRecordSignature(manifest as unknown as { readonly [key: string]: unknown }, keys);
  if (checked.ok) return 'verified';
  return checked.reasonCode === 'UNKNOWN_KEY' ? 'unknown-key' : 'bad-signature';
}

export type PublisherChange = { readonly ok: true; readonly publishers: number } | { readonly ok: false; readonly reasonCode: 'PUBLISHER_ID_INVALID' | 'KEY_ID_INVALID' | 'KEY_NOT_ED25519' | 'PUBLISHER_UNKNOWN' | 'WRITE_FAILED' };

async function writeLocal(home: string, publishers: readonly PackPublisher[]): Promise<boolean> {
  const document = {
    schemaVersion: 1,
    $comment: 'Pack publishers this user trusts (jevris pack publisher add|remove). A signature identifies a publisher; it does not prove a pack is safe.',
    publishers: publishers.map((item) => ({ id: item.id, keys: item.keys.map((key) => ({ keyId: key.keyId, publicKeyPem: key.publicKeyPem })) })),
  };
  const written = await writePrivateFile(localPublishersPath(home), `${JSON.stringify(document, null, 2)}\n`);
  return written.ok;
}

/** Adds (or extends) a local publisher with one Ed25519 public key. The caller has confirmed it. */
export async function addPublisher(home: string, id: string, keyId: string, publicKeyPem: string): Promise<PublisherChange> {
  if (!PUBLISHER_ID.test(id)) return { ok: false, reasonCode: 'PUBLISHER_ID_INVALID' };
  if (!KEY_ID.test(keyId)) return { ok: false, reasonCode: 'KEY_ID_INVALID' };
  if (!isEd25519(publicKeyPem)) return { ok: false, reasonCode: 'KEY_NOT_ED25519' };
  const text = await readText(localPublishersPath(home));
  const local = text === null ? [] : parsePublishers(text, 'local');
  const existing = local.find((item) => item.id === id);
  const key = { keyId, publicKeyPem: createPublicKey(publicKeyPem).export({ type: 'spki', format: 'pem' }) };
  const next = existing === undefined
    ? [...local, { id, keys: [key], source: 'local' as const }]
    : local.map((item) => (item.id === id ? { ...item, keys: [...item.keys.filter((k) => k.keyId !== keyId), key] } : item));
  return (await writeLocal(home, next)) ? { ok: true, publishers: next.length } : { ok: false, reasonCode: 'WRITE_FAILED' };
}

/** Removes a local publisher. Shipped publishers change only with a release. */
export async function removePublisher(home: string, id: string): Promise<PublisherChange> {
  const text = await readText(localPublishersPath(home));
  const local = text === null ? [] : parsePublishers(text, 'local');
  if (!local.some((item) => item.id === id)) return { ok: false, reasonCode: 'PUBLISHER_UNKNOWN' };
  const next = local.filter((item) => item.id !== id);
  return (await writeLocal(home, next)) ? { ok: true, publishers: next.length } : { ok: false, reasonCode: 'WRITE_FAILED' };
}
