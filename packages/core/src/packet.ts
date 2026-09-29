/**
 * The evidence packet builder (DEC-02, §2.3, §7.3, §23.2).
 *
 * The `state` sent to Jev keeps trusted policy apart from untrusted content:
 *
 *   { objective, phase, trustedPolicy, facts, candidates, missingEvidence,
 *     untrustedEvidence: [{ span, source, text }], truncated, omittedCategories }
 *
 * - Every string is checked for credentials before anything is built; a hit refuses the packet.
 * - Span ids are stable: the same evidence id and text always give the same span id, so Jev
 *   chooses span ids and software assembles the exact text afterwards.
 * - Mandatory evidence is never dropped. Optional evidence goes first, then high-priority
 *   evidence; the packet then says `truncated: true` and lists the omitted categories. If the
 *   mandatory facts alone do not fit, the packet is refused (staged reasoning is needed).
 * - Every packet has a `state`; a request without one is never built.
 * - Source egress (GOV-01, US02): unless the administrator approved egress, no evidence text
 *   leaves the machine. Each item is replaced in `withheldEvidence` by bounded structured
 *   features (span id, source kind, category, character count and a digest salted per engine),
 *   and `untrustedEvidence` stays empty. With egress approved, text is still screened for
 *   secrets first (a hit refuses the packet) and capped by the size limits.
 */
import { containsSecret, contentHash, sha256Hex, type Json } from '@jevris/contracts';
import { estimateJsonTokens } from './decision-tokens.js';
import { screenText } from './egress.js';

export const PACKET_EVIDENCE_PRIORITIES = ['mandatory', 'high', 'optional'] as const;
export type PacketEvidencePriority = (typeof PACKET_EVIDENCE_PRIORITIES)[number];

export const PACKET_SOURCE_KINDS = ['user', 'file', 'tool', 'policy', 'receipt'] as const;
export type PacketSourceKind = (typeof PACKET_SOURCE_KINDS)[number];

export interface PacketEvidence {
  readonly id: string;
  readonly text: string;
  readonly sourceKind: PacketSourceKind;
  readonly priority: PacketEvidencePriority;
  /** Category reported when this item is omitted (default: the source kind). */
  readonly category?: string;
}

export interface PacketCandidate {
  readonly id: string;
  readonly description: string;
}

export interface PacketInput {
  readonly objective: string;
  readonly phase?: string;
  /** Trusted policy from the installed configuration. Never repository text. */
  readonly trustedPolicy: { readonly [key: string]: Json };
  /** Deterministic facts computed in code (counts, flags, check ids). */
  readonly facts: { readonly [key: string]: Json };
  readonly evidence: readonly PacketEvidence[];
  readonly candidates?: readonly PacketCandidate[];
  readonly missingEvidence?: readonly string[];
}

export interface PacketLimits {
  /** Upper bound on the conservative token estimate of the whole state. */
  readonly maxStateTokens: number;
  /** Longest single evidence quotation, in characters. Longer mandatory text refuses. */
  readonly maxSpanChars: number;
  readonly maxEvidenceItems: number;
}

export const DEFAULT_PACKET_LIMITS: PacketLimits = Object.freeze({ maxStateTokens: 24_000, maxSpanChars: 4000, maxEvidenceItems: 128 });

export interface PacketSpan {
  readonly span: string;
  readonly source: PacketSourceKind;
  readonly text: string;
}

/** Structured features that stand in for evidence text while egress is not approved. */
export interface WithheldSpan {
  readonly span: string;
  readonly source: PacketSourceKind;
  readonly category: string;
  readonly characters: number;
  /** A salted digest (per engine), so equal evidence can be matched without revealing it. */
  readonly digest: string | null;
}

export type PacketSourceEgress = 'approved' | 'denied';

export interface PacketOptions {
  /** `approved` only when the administrator approved source egress (core `decideEgress`). */
  readonly sourceEgress: PacketSourceEgress;
  /** Secret salt for withheld digests; without it no digest is sent. */
  readonly salt?: string;
}

export interface PacketState {
  readonly objective: string;
  readonly phase: string | null;
  readonly trustedPolicy: { readonly [key: string]: Json };
  readonly facts: { readonly [key: string]: Json };
  readonly candidates: readonly PacketCandidate[];
  readonly missingEvidence: readonly string[];
  readonly untrustedEvidence: readonly PacketSpan[];
  readonly withheldEvidence: readonly WithheldSpan[];
  readonly truncated: boolean;
  readonly omittedCategories: readonly string[];
}

export type PacketRefusal = 'SECRET_BLOCKED' | 'INVALID_PACKET' | 'MANDATORY_DOES_NOT_FIT';

export type PacketResult =
  | {
      readonly ok: true;
      readonly state: PacketState;
      readonly packetHash: string;
      readonly stateTokens: number;
      /** Evidence id to span id, for every included item. */
      readonly spans: Readonly<Record<string, string>>;
      readonly includedIds: readonly string[];
      readonly omittedIds: readonly string[];
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly reasonCode: PacketRefusal;
      readonly field: string | null;
      /** SECRET_BLOCKED: where each finding is, by field pointer, rule and offsets; never the text. */
      readonly findings?: readonly SecretLocation[];
    };

/**
 * One screening finding in a refused packet (W06: "a redacted decision with source offsets").
 * `start` and `length` are UTF-16 offsets into the field; null when only the generic secret
 * shape check matched and no rule reported offsets.
 */
export interface SecretLocation {
  readonly field: string;
  readonly ruleId: string;
  readonly start: number | null;
  readonly length: number | null;
}

const MAX_FINDINGS = 16;

/** Packet field names a finding pointer may name; any other segment (a caller's key) is `*`. */
const POINTER_NAMES = new Set(['objective', 'phase', 'trustedPolicy', 'facts', 'evidence', 'candidates', 'missingEvidence', 'id', 'text', 'sourceKind', 'priority', 'category', 'description']);

/** A pointer safe to record: known field names and indexes only, so a key can never leak. */
function safePointer(path: string): string {
  const segments = path.split('/').slice(1, 9).map((segment) => (POINTER_NAMES.has(segment) || /^(?:0|[1-9][0-9]{0,3})$/.test(segment) ? segment : '*'));
  return segments.map((segment) => ['', segment].join('/')).join('');
}

/** Stable span id for one evidence item. */
export function spanId(evidenceId: string, text: string): string {
  return `s${sha256Hex(`${evidenceId}\u0000${text}`).slice(0, 12)}`;
}

/** A JSON pointer (RFC 6901 style) from its segments. */
function pointer(...segments: readonly (string | number)[]): string {
  return segments.map((segment) => ['', String(segment)].join('/')).join('');
}

function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') {
    yield [path, value];
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) yield* strings(value[i], path + pointer(i));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      yield [`${path + pointer(key)}#key`, key];
      yield* strings(inner, path + pointer(key));
    }
  }
}

/**
 * Every string that would be sent, keys included, through the deterministic secret and
 * sensitive-path rules the transport guard applies (GOV-08), plus the contracts' secret shapes.
 * The guard then never has to refuse what the builder produced; it stays the backstop.
 */
function secretFindings(input: unknown): SecretLocation[] {
  const out: SecretLocation[] = [];
  for (const [path, text] of strings(input, '')) {
    const field = safePointer(path.replace(/#key$/, ''));
    const found = screenText(text);
    for (const finding of found) {
      if (out.length >= MAX_FINDINGS) return out;
      out.push({ field, ruleId: finding.ruleId, start: finding.start, length: finding.length });
    }
    if (found.length === 0 && containsSecret(text)) {
      if (out.length >= MAX_FINDINGS) return out;
      out.push({ field, ruleId: 'secret-shape', start: null, length: null });
    }
  }
  return out;
}

const CATEGORY = /^[a-z][a-z0-9-]{0,31}$/;

const PRIORITY_RANK: Readonly<Record<PacketEvidencePriority, number>> = { mandatory: 0, high: 1, optional: 2 };

function wellFormed(input: PacketInput, limits: PacketLimits): string | null {
  if (input === null || typeof input !== 'object') return '';
  if (typeof input.objective !== 'string' || input.objective.trim() === '') return '/objective';
  if (input.phase !== undefined && typeof input.phase !== 'string') return '/phase';
  if (input.trustedPolicy === null || typeof input.trustedPolicy !== 'object' || Array.isArray(input.trustedPolicy)) return '/trustedPolicy';
  if (input.facts === null || typeof input.facts !== 'object' || Array.isArray(input.facts)) return '/facts';
  if (!Array.isArray(input.evidence) || input.evidence.length > limits.maxEvidenceItems) return '/evidence';
  const ids = new Set<string>();
  for (let i = 0; i < input.evidence.length; i += 1) {
    const item = input.evidence[i];
    if (item === undefined || typeof item.id !== 'string' || item.id === '' || ids.has(item.id)) return pointer('evidence', i, 'id');
    ids.add(item.id);
    if (typeof item.text !== 'string') return pointer('evidence', i, 'text');
    if (!(PACKET_SOURCE_KINDS as readonly string[]).includes(item.sourceKind)) return pointer('evidence', i, 'sourceKind');
    if (!(PACKET_EVIDENCE_PRIORITIES as readonly string[]).includes(item.priority)) return pointer('evidence', i, 'priority');
    if (item.text.length > limits.maxSpanChars && item.priority === 'mandatory') return pointer('evidence', i, 'text');
  }
  if (input.candidates !== undefined && (!Array.isArray(input.candidates) || input.candidates.some((c) => typeof c?.id !== 'string' || typeof c.description !== 'string'))) {
    return '/candidates';
  }
  if (input.missingEvidence !== undefined && (!Array.isArray(input.missingEvidence) || input.missingEvidence.some((m) => typeof m !== 'string'))) {
    return '/missingEvidence';
  }
  return null;
}

/**
 * Builds the packet. `limits.maxStateTokens` is the budget for the whole state; a repack passes a
 * smaller budget and gets the same mandatory content with less optional evidence.
 */
export function buildPacket(input: PacketInput, limits: PacketLimits = DEFAULT_PACKET_LIMITS, options: PacketOptions = { sourceEgress: 'denied' }): PacketResult {
  const bad = wellFormed(input, limits);
  if (bad !== null) return { ok: false, reasonCode: 'INVALID_PACKET', field: bad };
  const approved = options.sourceEgress === 'approved';
  // Withheld text never leaves, so only what is sent is screened; everything sent is screened.
  const findings = secretFindings(approved ? input : { ...input, evidence: [] });
  if (findings.length > 0) return { ok: false, reasonCode: 'SECRET_BLOCKED', field: findings[0]?.field ?? null, findings };
  const category = (item: PacketEvidence): string => (item.category !== undefined && CATEGORY.test(item.category) ? item.category : item.sourceKind);
  const withhold = (item: PacketEvidence): WithheldSpan => ({
    span: spanId(item.id, item.text),
    source: item.sourceKind,
    category: category(item),
    characters: item.text.length,
    digest: options.salt === undefined ? null : `h${sha256Hex(`${options.salt}\u0000${item.text}`).slice(0, 16)}`,
  });

  const ordered = input.evidence
    .map((item, index) => ({ item, index }))
    .sort((a, b) => PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority] || a.index - b.index);
  const included: { item: PacketEvidence; index: number }[] = [];
  const omitted: PacketEvidence[] = [];

  const assemble = (keep: readonly { item: PacketEvidence; index: number }[], dropped: readonly PacketEvidence[]): PacketState => {
    const sortedKeep = [...keep].sort((a, b) => a.index - b.index);
    const categories = [...new Set(dropped.map((item) => category(item)))].sort();
    return {
      objective: input.objective,
      phase: input.phase ?? null,
      trustedPolicy: input.trustedPolicy,
      facts: input.facts,
      candidates: [...(input.candidates ?? [])],
      missingEvidence: [...(input.missingEvidence ?? [])],
      untrustedEvidence: approved ? sortedKeep.map(({ item }) => ({ span: spanId(item.id, item.text), source: item.sourceKind, text: item.text })) : [],
      withheldEvidence: approved ? [] : sortedKeep.map(({ item }) => withhold(item)),
      truncated: dropped.length > 0,
      omittedCategories: categories,
    };
  };

  for (const entry of ordered) {
    if (entry.item.priority === 'mandatory') included.push(entry);
  }
  const optionalish = ordered.filter((entry) => entry.item.priority !== 'mandatory');
  // Mandatory content alone, with every non-mandatory item listed as omitted, must fit.
  const base = assemble(included, optionalish.map((entry) => entry.item));
  if (estimateJsonTokens(base) > limits.maxStateTokens) return { ok: false, reasonCode: 'MANDATORY_DOES_NOT_FIT', field: null };
  for (const entry of optionalish) {
    if (entry.item.text.length > limits.maxSpanChars) {
      omitted.push(entry.item);
      continue;
    }
    const rest = optionalish.filter((other) => other !== entry && !included.includes(other)).map((other) => other.item);
    const trial = assemble([...included, entry], rest);
    if (estimateJsonTokens(trial) <= limits.maxStateTokens) included.push(entry);
    else omitted.push(entry.item);
  }
  const state = assemble(included, omitted);
  const spans: Record<string, string> = {};
  for (const { item } of included) spans[item.id] = spanId(item.id, item.text);
  return {
    ok: true,
    state,
    packetHash: contentHash(state),
    stateTokens: estimateJsonTokens(state),
    spans,
    includedIds: included.sort((a, b) => a.index - b.index).map(({ item }) => item.id),
    omittedIds: omitted.map((item) => item.id),
    truncated: state.truncated,
  };
}

/** Resolves span ids Jev chose back to the exact evidence text. Unknown ids are dropped. */
export function assembleSpans(state: PacketState, chosen: readonly string[]): readonly PacketSpan[] {
  const bySpan = new Map(state.untrustedEvidence.map((span) => [span.span, span]));
  const out: PacketSpan[] = [];
  for (const id of chosen) {
    const span = bySpan.get(id);
    if (span !== undefined) out.push(span);
  }
  return out;
}
