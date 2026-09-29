/**
 * Small shared guards for the orchestration package. Inputs from frames, files and CLI flags
 * are untrusted: plain objects only, no prototype keys, bounded ids.
 */
import { createHash } from 'node:crypto';
import { SECRET_PATTERNS } from '@jevris/contracts';

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);

export type Rec = { readonly [key: string]: unknown };

export function isPlain(value: unknown): value is Rec {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || DANGEROUS.has(key)) return false;
  }
  return true;
}

export function own(value: Rec, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function str(value: Rec, key: string, max = 4096): string | undefined {
  const v = own(value, key);
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) return undefined;
  return v;
}

export function idList(value: unknown, max = 1024): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (!isId(item)) return undefined;
    out.push(item);
  }
  return out;
}

export function strList(value: unknown, max = 1024, maxLen = 4096): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > maxLen || item.includes('\0')) return undefined;
    out.push(item);
  }
  return out;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON: object keys sorted recursively. Used for hashing records. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value as Rec).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = (value as Rec)[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableJson(item)}`);
  }
  return `{${parts.join(',')}}`;
}

export function hashOf(value: unknown): string {
  return sha256(stableJson(value));
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export interface WallClock {
  now(): number;
}

export const systemClock: WallClock = { now: () => Date.now() };

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A short random id with a readable prefix, safe for ID_PATTERN. */
export function newId(prefix: string, entropy: string): string {
  return `${prefix}-${entropy.slice(0, 20)}`;
}

/** Tokens for lexical matching: lower-case words of 2+ characters. */
export function tokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);
}

/** True when `needle` occurs in `hay` on token boundaries (C1 does not match C10). */
export function containsToken(hay: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(hay);
}


const SECRET_REGEXES = SECRET_PATTERNS.map((pattern) => new RegExp(pattern, 'gu'));

/** Replaces every credential shape the contracts refuse with a fixed marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const regex of SECRET_REGEXES) {
    regex.lastIndex = 0;
    out = out.replace(regex, (match) => {
      // The high-entropy pattern may consume one leading separator; keep it.
      const lead = /^[^A-Za-z0-9_-]/.test(match) ? match[0] : '';
      return `${lead}[redacted]`;
    });
  }
  return out;
}

/** A composite ledger record id (a lookup key, never a filesystem path; the ledger hashes it). */
export function recordKey(...parts: readonly string[]): string {
  return parts.join('/');
}

/**
 * Model-visible text: secrets redacted, URLs neutralised (contract free text refuses both),
 * bounded, never empty.
 */
export function safeText(text: string, max = 1000): string {
  const out = redactSecrets(text)
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\//g, '[url]')
    .replace(/(^|[^A-Za-z0-9])www\./g, '$1[url].')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return out.length === 0 ? '-' : out;
}

/** Conservative token estimate: 4 characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
