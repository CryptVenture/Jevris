import { isAbsoluteOnAnyPlatform } from '@jevris/platform';
import { createHash } from 'node:crypto';
import type {
  EvidenceShortlistResult,
  EvidenceSpan,
  MissingEvidence,
  SkillInventoryEntry,
  SkillShortlistResult,
} from '@jevris/contracts';

/**
 * Closed shortlist. Ranking reads named fields only.
 * An unknown id is recorded. It is not loaded.
 * A missing evidence id stays missing.
 */

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(['none', 'unknown']);
const SPAN_LIMIT = 4096;
const FETCH_LIMIT = 8;
const SCAN_LIMIT = 64;
const INVENTORY_LIMIT = 64;
const ID_BYTE_LIMIT = 256;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function hasDangerousKey(value: object): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || dangerous.has(key)) return true;
  }
  return false;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function asCallable(value: unknown): ((...args: readonly unknown[]) => unknown) | null {
  if (typeof value !== 'function') return null;
  return value as (...args: readonly unknown[]) => unknown;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

function closedSkills(): SkillShortlistResult {
  return {
    schemaVersion: '1.0',
    options: ['none'],
    selected: 'none',
    executed: false,
    unknownRejected: [],
    truncated: false,
    inventory: [],
  };
}

function closedEvidence(): EvidenceShortlistResult {
  return {
    schemaVersion: '1.0',
    uploaded: false,
    spans: [],
    missing: [],
    truncated: false,
  };
}

function missingResult(ids: readonly string[]): EvidenceShortlistResult {
  const missing: MissingEvidence[] = [];
  for (const id of ids) missing.push({ id, state: 'missing' });
  return {
    schemaVersion: '1.0',
    uploaded: false,
    spans: [],
    missing,
    truncated: false,
  };
}

function intentTokens(intent: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  let current = '';
  for (const ch of intent) {
    const code = ch.codePointAt(0) ?? 0;
    const keep = (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || ch === '-';
    if (keep) {
      current += ch;
    } else if (current.length > 0) {
      tokens.add(current);
      current = '';
    }
  }
  if (current.length > 0) tokens.add(current);
  return tokens;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  const Ctor = (
    globalThis as unknown as {
      TextDecoder?: new (
        label: string,
        options: { fatal: boolean },
      ) => { decode(input?: Uint8Array): string };
    }
  ).TextDecoder;
  if (Ctor === undefined) return null;
  try {
    return new Ctor('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function descriptionFrom(bytes: Uint8Array): string | null {
  const text = decodeUtf8(bytes);
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  let description: string | null = null;
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (line === undefined || !line.startsWith('description:')) continue;
    const value = line.slice('description:'.length).trim();
    description = value.length === 0 ? null : value;
  }
  return description;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function utf8ByteLength(value: string): number {
  const Ctor = (
    globalThis as unknown as {
      TextEncoder?: new () => { encode(input?: string): Uint8Array };
    }
  ).TextEncoder;
  if (Ctor === undefined) return value.length * 4;
  return new Ctor().encode(value).byteLength;
}

function evidenceIdSafe(id: string): boolean {
  if (id.length === 0 || utf8ByteLength(id) > ID_BYTE_LIMIT) return false;
  if (id.includes('\0') || id.includes('\n') || id.includes('\r')) return false;
  if (isAbsoluteOnAnyPlatform(id)) return false;
  if (/^[A-Za-z]:/.test(id)) return false;
  const parts = id.split(/[/\\]/);
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') return false;
  }
  return true;
}

function asBytes(value: unknown): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null;
  return value;
}

function prefixOf(value: unknown): { readonly bytes: Uint8Array; readonly truncated: boolean } | null {
  if (!isPlainObject(value) || hasDangerousKey(value)) return null;
  const bytes = asBytes(own(value, 'bytes'));
  if (bytes === null) return null;
  return { bytes, truncated: own(value, 'truncated') === true };
}

function toSpan(
  id: string,
  prefix: { readonly bytes: Uint8Array; readonly truncated: boolean },
): EvidenceSpan {
  let bytes = prefix.bytes;
  let truncated = prefix.truncated;
  if (bytes.byteLength > SPAN_LIMIT) {
    bytes = bytes.subarray(0, SPAN_LIMIT);
    truncated = true;
  }
  return {
    id,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    truncated,
    text: decodeUtf8(bytes) ?? '',
  };
}

function basenameOf(relativeId: string): string {
  const parts = relativeId.split(/[/\\]/);
  const base = parts[parts.length - 1];
  return base ?? '';
}

function nameMatchesIntent(relativeId: string, tokens: ReadonlySet<string>): boolean {
  if (tokens.size === 0) return false;
  const base = basenameOf(relativeId);
  if (base.length === 0) return false;
  if (tokens.has(base)) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return tokens.has(base.slice(0, dot));
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function plainField(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '\n' || ch === '\r' || ch === '\u001b') continue;
    out += ch;
  }
  return out;
}

export async function shortlistInstalledSkills(input: unknown): Promise<SkillShortlistResult> {
  if (!isPlainObject(input) || hasDangerousKey(input)) return closedSkills();
  const reader = own(input, 'reader');
  if (!isPlainObject(reader) || hasDangerousKey(reader)) return closedSkills();
  const listDirectories = own(reader, 'listDirectories');
  const readSkillMarkdown = own(reader, 'readSkillMarkdown');
  if (typeof listDirectories !== 'function' || typeof readSkillMarkdown !== 'function') {
    return closedSkills();
  }

  const roots = stringList(own(input, 'roots'));
  const requestedIds = stringList(own(input, 'requestedIds'));
  const intentValue = own(input, 'intent');
  const intent = typeof intentValue === 'string' ? intentValue : '';
  const candidates: { root: string; name: string }[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    let listed: unknown;
    try {
      listed = await Reflect.apply(listDirectories, undefined, [root]);
    } catch {
      continue;
    }
    if (!Array.isArray(listed)) continue;
    for (const name of stringList(listed)) {
      if (!SKILL_ID.test(name) || RESERVED.has(name) || seen.has(name)) continue;
      seen.add(name);
      candidates.push({ root, name });
    }
  }
  candidates.sort((left, right) => compareIds(left.name, right.name));
  const truncated = candidates.length > INVENTORY_LIMIT;
  const limited = truncated ? candidates.slice(0, INVENTORY_LIMIT) : candidates;
  const found = new Map<string, string | null>();
  for (const candidate of limited) {
    let markdown: unknown;
    try {
      markdown = await Reflect.apply(readSkillMarkdown, undefined, [candidate.root, candidate.name]);
    } catch {
      continue;
    }
    const bytes = asBytes(markdown);
    if (bytes === null) continue;
    found.set(candidate.name, descriptionFrom(bytes));
  }

  const inventory: SkillInventoryEntry[] = [];
  for (const id of [...found.keys()].sort(compareIds)) {
    inventory.push({ id, description: found.get(id) ?? null });
  }
  const known = new Set(inventory.map((entry) => entry.id));
  const tokens = intentTokens(intent);
  const applicable = inventory.map((entry) => entry.id).filter((id) => tokens.has(id));
  const unknownRejected: string[] = [];
  const seenUnknown = new Set<string>();
  for (const id of requestedIds) {
    if (known.has(id) || seenUnknown.has(id)) continue;
    seenUnknown.add(id);
    unknownRejected.push(id);
  }
  const selected = applicable.length === 1 ? applicable[0] ?? 'none' : 'none';
  return {
    schemaVersion: '1.0',
    options: [...applicable, 'none'],
    selected,
    executed: false,
    unknownRejected,
    truncated,
    inventory,
  };
}

export async function shortlistEvidence(input: unknown): Promise<EvidenceShortlistResult> {
  if (!isPlainObject(input) || hasDangerousKey(input)) return closedEvidence();
  const ids = stringList(own(input, 'ids'));
  const roots = stringList(own(input, 'roots'));
  const intentValue = own(input, 'intent');
  const intent = typeof intentValue === 'string' ? intentValue : '';
  const reader = own(input, 'reader');
  if (!isPlainObject(reader) || hasDangerousKey(reader)) return missingResult(ids);
  const readPrefix = asCallable(own(reader, 'readPrefix'));
  if (readPrefix === null) return missingResult(ids);
  const read = readPrefix;

  const tokens = intentTokens(intent);
  const spans: EvidenceSpan[] = [];
  const missing: MissingEvidence[] = [];
  const attempted = new Set<string>();
  let fetches = 0;
  let truncated = false;

  async function readOne(
    id: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean } | null> {
    for (const root of roots) {
      if (fetches >= FETCH_LIMIT) {
        truncated = true;
        return null;
      }
      fetches += 1;
      let value: unknown;
      try {
        value = await Reflect.apply(read, undefined, [root, id]);
      } catch {
        continue;
      }
      const prefix = prefixOf(value);
      if (prefix !== null) return prefix;
    }
    return null;
  }

  for (const id of ids) {
    if (attempted.has(id)) continue;
    attempted.add(id);
    if (!evidenceIdSafe(id)) {
      missing.push({ id, state: 'missing' });
      continue;
    }
    if (fetches >= FETCH_LIMIT) {
      truncated = true;
      missing.push({ id, state: 'missing' });
      continue;
    }
    const prefix = await readOne(id);
    if (prefix === null) {
      missing.push({ id, state: 'missing' });
      continue;
    }
    spans.push(toSpan(id, prefix));
  }

  const listFiles = asCallable(own(reader, 'listFiles'));
  if (listFiles !== null) {
    const matches: string[] = [];
    const seenMatch = new Set<string>();
    let examined = 0;
    for (const root of roots) {
      if (examined >= SCAN_LIMIT) {
        truncated = true;
        break;
      }
      let listed: unknown;
      try {
        listed = await Reflect.apply(listFiles, undefined, [root]);
      } catch {
        continue;
      }
      if (!Array.isArray(listed)) continue;
      for (const item of listed) {
        if (examined >= SCAN_LIMIT) {
          truncated = true;
          break;
        }
        examined += 1;
        if (typeof item !== 'string') continue;
        if (utf8ByteLength(item) > ID_BYTE_LIMIT) continue;
        if (!evidenceIdSafe(item) || attempted.has(item) || seenMatch.has(item)) continue;
        if (!nameMatchesIntent(item, tokens)) continue;
        seenMatch.add(item);
        matches.push(item);
      }
    }
    matches.sort(compareIds);
    for (const id of matches) {
      if (fetches >= FETCH_LIMIT) {
        truncated = true;
        break;
      }
      attempted.add(id);
      const prefix = await readOne(id);
      if (prefix === null) continue;
      spans.push(toSpan(id, prefix));
    }
  }

  return {
    schemaVersion: '1.0',
    uploaded: false,
    spans,
    missing,
    truncated,
  };
}

export function formatShortlist(
  skills: SkillShortlistResult,
  evidence: EvidenceShortlistResult,
): string {
  const options = skills.options.length === 0 ? ['none'] : skills.options;
  const unknown =
    skills.unknownRejected.length === 0
      ? '0'
      : skills.unknownRejected.map(plainField).join(', ');
  const lines = [
    'executed: false',
    'uploaded: false',
    `skills options: ${options.map(plainField).join(', ')}`,
    `skills selected: ${plainField(skills.selected)}`,
    `unknown rejected: ${unknown}`,
    `evidence spans: ${String(evidence.spans.length)}`,
  ];
  for (const item of evidence.missing) {
    lines.push(`evidence missing: ${plainField(item.id)} state: missing`);
  }
  const report = {
    skills: {
      schemaVersion: skills.schemaVersion,
      options: skills.options,
      selected: skills.selected,
      executed: false as const,
      unknownRejected: skills.unknownRejected,
      truncated: skills.truncated,
      inventory: skills.inventory,
    },
    evidence: {
      schemaVersion: evidence.schemaVersion,
      uploaded: false as const,
      spans: evidence.spans,
      missing: evidence.missing,
      truncated: evidence.truncated,
    },
  };
  lines.push(`JEVRIS_REPORT ${JSON.stringify(report)}`);
  return `${lines.join('\n')}\n`;
}
