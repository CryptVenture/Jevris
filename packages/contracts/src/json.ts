/**
 * Plain JSON values, the JSON-value gate, RFC 8785 canonical serialisation and bounded parsing.
 * Absent and null are distinct: a property whose value is `undefined` is not JSON and is refused.
 */

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export const MAX_JSON_DEPTH = 64;
export const DEFAULT_MAX_JSON_BYTES = 1_048_576;
export const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

export interface JsonIssue {
  readonly path: string;
  readonly code: string;
}

function pointer(parts: readonly (string | number)[]): string {
  return parts.map((part) => '/' + String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns the first reason `value` is not a plain JSON value, or null when it is.
 * Refuses undefined, functions, symbols, bigints, non-finite numbers, class instances,
 * sparse arrays, cycles, prototype-pollution keys and nesting beyond MAX_JSON_DEPTH.
 */
export function jsonIssue(value: unknown): JsonIssue | null {
  const seen = new Set<object>();
  const visit = (node: unknown, path: (string | number)[], depth: number): JsonIssue | null => {
    if (depth > MAX_JSON_DEPTH) return { path: pointer(path), code: 'JSON_DEPTH' };
    if (node === null) return null;
    switch (typeof node) {
      case 'boolean':
      case 'string':
        return null;
      case 'number':
        return Number.isFinite(node) ? null : { path: pointer(path), code: 'JSON_NUMBER' };
      case 'undefined':
        return { path: pointer(path), code: 'JSON_UNDEFINED' };
      case 'object':
        break;
      default:
        return { path: pointer(path), code: 'JSON_TYPE' };
    }
    const objectNode = node as object;
    if (seen.has(objectNode)) return { path: pointer(path), code: 'JSON_CYCLE' };
    seen.add(objectNode);
    try {
      if (Array.isArray(objectNode)) {
        for (let index = 0; index < objectNode.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(objectNode, index)) {
            return { path: pointer([...path, index]), code: 'JSON_UNDEFINED' };
          }
          const issue = visit(objectNode[index], [...path, index], depth + 1);
          if (issue !== null) return issue;
        }
        return null;
      }
      if (!isPlainObject(objectNode)) return { path: pointer(path), code: 'JSON_TYPE' };
      if (Object.getOwnPropertySymbols(objectNode).length > 0) return { path: pointer(path), code: 'JSON_TYPE' };
      for (const key of Object.keys(objectNode)) {
        if (FORBIDDEN_KEYS.includes(key)) return { path: pointer([...path, key]), code: 'JSON_FORBIDDEN_KEY' };
        const issue = visit((objectNode as Record<string, unknown>)[key], [...path, key], depth + 1);
        if (issue !== null) return issue;
      }
      // Own non-enumerable or accessor properties are not JSON data.
      for (const key of Object.getOwnPropertyNames(objectNode)) {
        const descriptor = Object.getOwnPropertyDescriptor(objectNode, key);
        if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) {
          return { path: pointer([...path, key]), code: 'JSON_TYPE' };
        }
      }
      return null;
    } finally {
      seen.delete(objectNode);
    }
  };
  return visit(value, [], 0);
}

export function isJson(value: unknown): value is Json {
  return jsonIssue(value) === null;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('JSON_NUMBER');
  // ECMAScript Number::toString is the RFC 8785 number form; -0 serialises as 0.
  return Object.is(value, -0) ? '0' : JSON.stringify(value);
}

function canonicalString(value: string): string {
  // JSON.stringify escapes exactly the RFC 8785 set (quote, backslash, controls as \b \f \n \r \t
  // or \u00XX lowercase) and, since ES2019, lone surrogates as \uXXXX.
  return JSON.stringify(value);
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** RFC 8785 (JCS) canonical JSON. Throws on a value that is not plain JSON. */
export function canonicalJson(value: unknown): string {
  const issue = jsonIssue(value);
  if (issue !== null) throw new Error(issue.code);
  const write = (node: unknown): string => {
    if (node === null) return 'null';
    if (typeof node === 'boolean') return node ? 'true' : 'false';
    if (typeof node === 'number') return canonicalNumber(node);
    if (typeof node === 'string') return canonicalString(node);
    if (Array.isArray(node)) return '[' + node.map(write).join(',') + ']';
    const objectNode = node as Record<string, unknown>;
    const keys = Object.keys(objectNode).sort(compareUtf16);
    return '{' + keys.map((key) => canonicalString(key) + ':' + write(objectNode[key])).join(',') + '}';
  };
  return write(value);
}

/** A deep, frozen copy of a plain JSON value. */
export function frozenCopy<T>(value: T): T {
  const copy = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return Object.freeze(node.map(copy));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node)) out[key] = copy((node as Record<string, unknown>)[key]);
    return Object.freeze(out);
  };
  return copy(value) as T;
}

interface Utf8Codec {
  decode(input?: Uint8Array): string;
}

interface Utf8Encoder {
  encode(input?: string): Uint8Array;
}

export function utf8Bytes(text: string): Uint8Array {
  const Ctor = (globalThis as unknown as { TextEncoder?: new () => Utf8Encoder }).TextEncoder;
  if (Ctor === undefined) throw new Error('TEXT_ENCODER');
  return new Ctor().encode(text);
}

function decodeUtf8(bytes: Uint8Array): string {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean; ignoreBOM: boolean }) => Utf8Codec;
  }).TextDecoder;
  if (Ctor === undefined) throw new Error('TEXT_DECODER');
  return new Ctor('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export type JsonParseResult =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly issues: readonly JsonIssue[] };

/**
 * Parses UTF-8 bytes (or a string) into a plain JSON value. The byte cap is checked before
 * decoding; invalid UTF-8, a byte-order mark and malformed JSON are refused without echoing input.
 */
export function parseJson(input: Uint8Array | string, maxBytes = DEFAULT_MAX_JSON_BYTES): JsonParseResult {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : input;
  if (bytes.byteLength > maxBytes) return { ok: false, issues: [{ path: '', code: 'TOO_LARGE' }] };
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    return { ok: false, issues: [{ path: '', code: 'INVALID_UTF8' }] };
  }
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, issues: [{ path: '', code: 'BOM' }] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path: '', code: 'INVALID_JSON' }] };
  }
  const issue = jsonIssue(value);
  if (issue !== null) return { ok: false, issues: [issue] };
  return { ok: true, value: value as Json };
}
