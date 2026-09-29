/**
 * Ed25519 signatures over the canonical JSON of a record without its `signature` field.
 * Shared by the calibration release pipeline, the routing loader, doctor and the portability gate.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalJson, utf8Bytes } from './json.js';
import type { Signature } from './primitives.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '=';
  }
  return out;
}

/** Strict base64 decoding: canonical padding only. Returns null on any malformed input. */
export function base64Decode(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const values = [0, 1, 2, 3].map((k) => {
      const ch = text[i + k] as string;
      return ch === '=' ? 0 : ALPHABET.indexOf(ch);
    });
    const n = ((values[0] as number) << 18) | ((values[1] as number) << 12) | ((values[2] as number) << 6) | (values[3] as number);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return base64Encode(out) === text ? out : null;
}

type Signable = { readonly [key: string]: unknown };

/** The exact bytes that are signed: RFC 8785 canonical JSON of the record without `signature`. */
export function signingPayload(record: Signable): Uint8Array {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) if (key !== 'signature') rest[key] = record[key];
  return utf8Bytes(canonicalJson(rest));
}

/** Signs an unsigned record with a PEM (PKCS#8) Ed25519 private key. For the release pipeline and tests. */
export function signRecord<T extends Signable>(unsigned: T, privateKeyPem: string, keyId: string): T & { readonly signature: Signature } {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('SIGNING_KEY_NOT_ED25519');
  const value = base64Encode(sign(null, signingPayload(unsigned), key));
  return { ...unsigned, signature: { algorithm: 'ed25519', keyId, value } };
}

export type SignatureCheck =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly reasonCode: 'MISSING_SIGNATURE' | 'UNKNOWN_KEY' | 'INVALID_KEY' | 'BAD_SIGNATURE' };

/**
 * Verifies a record's Ed25519 signature against trusted public keys (PEM SPKI) keyed by key id.
 * The record should already have passed its contract. A key id that is not trusted is refused.
 */
export function verifyRecordSignature(record: Signable, trustedKeys: ReadonlyMap<string, string>): SignatureCheck {
  const signature = record['signature'] as Partial<Signature> | undefined;
  if (signature === undefined || signature === null || typeof signature !== 'object') return { ok: false, reasonCode: 'MISSING_SIGNATURE' };
  if (signature.algorithm !== 'ed25519' || typeof signature.keyId !== 'string' || typeof signature.value !== 'string') {
    return { ok: false, reasonCode: 'MISSING_SIGNATURE' };
  }
  const pem = trustedKeys.get(signature.keyId);
  if (pem === undefined) return { ok: false, reasonCode: 'UNKNOWN_KEY' };
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    return { ok: false, reasonCode: 'INVALID_KEY' };
  }
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reasonCode: 'INVALID_KEY' };
  const bytes = base64Decode(signature.value);
  if (bytes === null || bytes.length !== 64) return { ok: false, reasonCode: 'BAD_SIGNATURE' };
  let valid = false;
  try {
    valid = verify(null, signingPayload(record), key, bytes);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, keyId: signature.keyId } : { ok: false, reasonCode: 'BAD_SIGNATURE' };
}
