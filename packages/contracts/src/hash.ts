import { createHash } from 'node:crypto';
import { canonicalJson } from './json.js';

/** `sha256:` followed by 64 lowercase hex digits. */
export const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';

export type ContentHash = `sha256:${string}`;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 over the RFC 8785 canonical JSON of a plain JSON value. Throws on non-JSON input. */
export function contentHash(value: unknown): ContentHash {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === 'string' && new RegExp(HASH_PATTERN).test(value);
}
