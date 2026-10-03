/**
 * Shared adapter core. This file is byte-identical in every `@jevris/adapter-*` package
 * (a conformance test checks it), so each package stays a closed graph with no runtime
 * import: the hook launcher and the Kilo and OpenCode shims can copy it as it is.
 *
 * Rules every adapter follows:
 * - Look only at a bounded, plain JSON object. Refuse prototype keys at any depth.
 * - Unknown values are null. Nothing is defaulted.
 * - The payload is a summary: names, sizes and flags, never prompt text, tool input values,
 *   tool output or file content.
 * - Decision inputs (the user's request, the paths a write touched, a failure's first error
 *   line, a tool's returned text for injection screening, a proposed call's effect) travel
 *   only as the separate, bounded `intent`, which the launcher puts next to the
 *   envelope in the sidecar body. They are never recorded in the envelope.
 * - Render only the "no decision" form, context, a certified route or a message. Never a
 *   permission decision.
 */
import type {
  HarnessEffectIntent,
  HarnessEvidenceIntent,
  HarnessFailureIntent,
  HarnessIntent,
  HarnessJson,
  HarnessScopeIntent,
  HarnessTaskIntent,
  HarnessUntrustedIntent,
  HookOutcome,
  NormalizeContext,
  NormalizeRefusal,
  NormalizeResult,
  NormalizedHarnessEvent,
} from '@jevris/contracts';

type HarnessId = NormalizedHarnessEvent['harness'];
type Json = { readonly [key: string]: HarnessJson };

export const INPUT_CAP = 131_072;
export const PAYLOAD_CAP = 4096;
export const CONTEXT_CAP = 8000;
/** Child sessions a Kilo or OpenCode shim remembers the parent of. */
export const PARENT_MEMORY = 512;
/**
 * How long a Kilo or OpenCode top-level chat.message waits for text to show on its turn (G4):
 * a cold node start (about 50 ms) plus the launcher and sidecar round trip (target under
 * 100 ms), with headroom. A miss adds nothing and is counted as SHIM_TIMEOUT.
 */
export const MESSAGE_TIMEOUT_MS = 300;
const FIELD_CAP = 256;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function own(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

/** True when any object at any depth (up to 64) has a prototype-polluting or symbol key. */
export function hasUnsafeKey(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasUnsafeKey(item, depth + 1));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) return true;
    if (hasUnsafeKey(Reflect.get(value, key), depth + 1)) return true;
  }
  return false;
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function jsonLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? utf8Length(text) : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A bounded single-line string, or null. Never an empty string. */
export function field(value: unknown, max = FIELD_CAP): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Kept identifiers that are not free text (B's LOW 30 on access limits R69): a permission mode
 * (`default`, `acceptEdits`, `plan`), an agent type (`general-purpose`, `Explore`,
 * `plugin:reviewer`) and a model id (`claude-opus-5-5[1m]`, `haiku`, `gpt-5.5`). A value of
 * another shape is dropped, never kept as text.
 */
const PERMISSION_MODE = /^[A-Za-z][A-Za-z_-]{0,31}$/;
const AGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

/** A bounded field that also matches `shape`, or null. */
export function shaped(value: unknown, shape: RegExp): string | null {
  const text = field(value, 128);
  return text !== null && shape.test(text) ? text : null;
}

export function permissionModeField(value: unknown): string | null {
  return shaped(value, PERMISSION_MODE);
}

export function agentTypeField(value: unknown): string | null {
  return shaped(value, AGENT_TYPE);
}

/**
 * A model id in its id shape. A Bedrock ARN (Claude Code takes one as a model) names the AWS
 * account, so it is kept only as the fixed `bedrock-arn`, never with its account id (B's LOW 32).
 */
export function modelIdField(value: unknown): string | null {
  const id = shaped(value, MODEL_ID);
  return id !== null && id.toLowerCase().startsWith('arn:') ? BEDROCK_ARN : id;
}

export const BEDROCK_ARN = 'bedrock-arn';

/**
 * A worker tool's requested model (C's subagent route). A model that is named but not readable in
 * its id shape is still the user's explicit choice, so it is kept as the fixed `unreadable-model`,
 * never as its text; the route then abstains as it does for any named model. Absent or empty: null.
 */
export function requestedModelField(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  return modelIdField(value) ?? UNREADABLE_MODEL;
}

export const UNREADABLE_MODEL = 'unreadable-model';

export function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2 ** 31 ? value : null;
}

/** Size of a native value without looking at its content. */
export function sizeOf(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return utf8Length(value);
  const length = jsonLength(value);
  return Number.isFinite(length) ? length : null;
}

/** Sorted key names of an object (bounded), never values. */
export function keyNames(value: unknown): readonly string[] | null {
  if (!isPlainObject(value)) return null;
  return Object.keys(value)
    .filter((key) => field(key, 64) !== null)
    .sort()
    .slice(0, 32);
}

/**
 * What makes one failed tool call the same approach as another (loop ledger, capsule): a one-way
 * digest of the call's input. The hook event carries names, sizes and this digest, never the input
 * text, so nothing readable about the command leaves the hook. Inputs that differ only in cosmetic
 * keys (a description, a timeout) or in spacing digest the same.
 */
export interface FailureIdentity {
  /** 16 hex characters of a SHA-256 over the tool name and the canonical input. */
  readonly digest: string;
}

const COSMETIC_INPUT_KEYS: ReadonlySet<string> = new Set(['description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox', 'tool_use_id']);
const IDENTITY_TEXT_CAP = 65_536;
const IDENTITY_DEPTH = 6;

/** Sorted-key JSON of a tool input with cosmetic keys left out and shell whitespace collapsed. */
function canonicalInput(value: unknown, depth = 0): string {
  if (typeof value === 'string') return JSON.stringify(value.replace(/\s+/g, ' ').trim());
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (depth >= IDENTITY_DEPTH) return '"~"';
  if (Array.isArray(value)) return `[${value.slice(0, 256).map((item) => canonicalInput(item, depth + 1)).join(',')}]`;
  const parts: string[] = [];
  for (const key of Object.keys(value).sort().slice(0, 64)) {
    if (depth === 0 && COSMETIC_INPUT_KEYS.has(key)) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalInput(own(value, key), depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

/** The payload field of a failure identity; nothing for a call without one. */
function failureIdentityPayload(identity: FailureIdentity | null): Record<string, string> {
  return identity === null ? {} : { toolInputDigest: identity.digest };
}

/** Identity of a failed tool call from its input, or null when there is no object input to identify. */
export function failureIdentity(toolName: string | null, toolInput: unknown): FailureIdentity | null {
  if (!isPlainObject(toolInput)) return null;
  const text = canonicalInput(toolInput);
  return { digest: sha256Hex(`${toolName ?? ''}\n${text.length}\n${text.slice(0, IDENTITY_TEXT_CAP)}`).slice(0, 16) };
}

/** Drops null entries and trims the summary until it fits the cap. */
export function boundedPayload(entries: Readonly<Record<string, HarnessJson | undefined>>): Json {
  const out: Record<string, HarnessJson> = {};
  for (const key of Object.keys(entries).sort()) {
    const value = entries[key];
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  while (jsonLength(out) > PAYLOAD_CAP) {
    const keys = Object.keys(out);
    const last = keys[keys.length - 1];
    if (last === undefined) break;
    delete out[last];
  }
  return out;
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), pure JavaScript so the adapter needs no runtime import.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return out;
}

export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  for (const word of [high, bitLength >>> 0]) bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64).fill(0);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0;
  }
  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// Building events and refusals.

export function refuse(reasonCode: NormalizeRefusal, nativeEventName: string | null): NormalizeResult {
  return { ok: false, reasonCode, nativeEventName };
}

export interface EventParts {
  readonly harness: HarnessId;
  readonly nativeEventName: string;
  readonly kind: string;
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
  readonly toolUseId?: string | null;
  readonly toolName?: string | null;
  readonly agentId?: string | null;
  /** Set only for a subagent's event; see subagentScope. */
  readonly parentSessionId?: string | null;
  readonly model?: string | null;
  readonly permissionMode?: string | null;
  readonly cwd?: string | null;
  readonly trigger?: string | null;
  readonly blocking: boolean;
  readonly responseRequired: boolean;
  readonly payload: Json;
  /** Extra identifying values for the dedup key, such as a step index or message id. */
  readonly dedup?: readonly (string | number | null)[];
  /** Structured decision inputs for the sidecar body, never part of the event. */
  readonly intent?: HarnessIntent;
}

export function buildEvent(parts: EventParts): NormalizeResult {
  const event: NormalizedHarnessEvent = {
    schemaVersion: '1.0',
    harness: parts.harness,
    nativeEventName: parts.nativeEventName,
    kind: parts.kind,
    sessionId: parts.sessionId ?? null,
    turnId: parts.turnId ?? null,
    toolUseId: parts.toolUseId ?? null,
    toolName: parts.toolName ?? null,
    agentId: parts.agentId ?? null,
    model: parts.model ?? null,
    permissionMode: parts.permissionMode ?? null,
    cwd: parts.cwd ?? null,
    trigger: parts.trigger ?? null,
    blocking: parts.blocking,
    responseRequired: parts.responseRequired,
    payload: parts.payload,
    dedupKey: '',
  };
  const identity = [
    event.harness,
    event.nativeEventName,
    event.sessionId,
    event.turnId,
    event.toolUseId,
    event.agentId,
    event.trigger,
    ...(parts.dedup ?? []),
  ];
  const parent = parts.parentSessionId ?? null;
  const done: NormalizedHarnessEvent = { ...event, ...(parent === null ? {} : { parentSessionId: parent }), dedupKey: sha256Hex(JSON.stringify(identity)) };
  const intent = parts.intent ?? {};
  return Object.keys(intent).length > 0 ? { ok: true, event: done, intent } : { ok: true, event: done };
}

// ---------------------------------------------------------------------------
// Decision inputs (INT-01..05). Bounded to C's trigger-handler limits; a field the harness
// does not provide is left out, never guessed.

export const OBJECTIVE_CAP = 4000;
const PATH_CAP = 1000;
const DIFF_CAP = 256;
const DIAGNOSTIC_CAP = 300;

/** Tools whose finished call wrote files (Claude, Codex, OpenCode/Kilo and Antigravity names). */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'edit',
  'write',
  'patch',
  'multiedit',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

/** Trimmed and clipped to `max` characters without splitting a surrogate pair; null if empty. */
function clipText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The user's request as the harness delivered it, verbatim and clipped. */
export function taskIntent(text: unknown): HarnessTaskIntent | null {
  const objective = clipText(text, OBJECTIVE_CAP);
  return objective === null ? null : { objective };
}

/** File paths named in a patch's headers (`*** Add File:`, `*** Update File:`, ...), never its body. */
export function patchPaths(patch: unknown): readonly string[] {
  if (typeof patch !== 'string') return [];
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/.exec(line.trimEnd());
    const path = match === null ? null : (match[1] ?? match[2] ?? null);
    if (path !== null) out.push(path);
    if (out.length >= DIFF_CAP) break;
  }
  return out;
}

/** A path relative to the session cwd when it lies inside it, otherwise as given. */
function workspacePath(path: string, cwd: string | null): string {
  if (cwd === null) return path;
  const base = cwd.replace(/[\\/]+$/, '');
  for (const sep of ['/', '\\']) {
    if (path.startsWith(base + sep) && path.length > base.length + 1) return path.slice(base.length + 1).split('\\').join('/');
  }
  return path;
}

/** INT-05: the paths one write touched. Null when it named none. */
export function scopeIntent(paths: readonly unknown[], cwd: string | null): HarnessScopeIntent | null {
  const seen = new Set<string>();
  for (const candidate of paths) {
    const path = field(candidate, PATH_CAP);
    if (path === null) continue;
    seen.add(workspacePath(path, cwd));
    if (seen.size >= DIFF_CAP) break;
  }
  if (seen.size === 0) return null;
  return { diff: [...seen].map((path) => ({ path })), requestedEffects: [] };
}

/** INT-04: a failed tool call's evidence. The error's first line is the only text kept. */
export function failureEvidence(toolName: string | null, error: unknown): HarnessEvidenceIntent {
  const first = typeof error === 'string' ? (error.split('\n').find((line) => line.trim().length > 0) ?? null) : null;
  const text = clipText(first, DIAGNOSTIC_CAP);
  return {
    required: [
      {
        id: 'failure-output',
        description: `The error output of the failed ${toolName ?? 'tool'} call`,
        available: text !== null,
        fresh: text !== null ? true : null,
      },
    ],
    ...(text === null ? {} : { diagnostics: [{ id: 'error', text }] }),
  };
}

// ---------------------------------------------------------------------------
// Live repeated-failure advice: the content-free features of a failed tool call. A closed set of
// codes, two one-way digests and booleans: no text, no path and no output. The vocabularies are
// the contracts' FAILURE_* lists (a test checks they agree); this file imports no runtime value.

export const FAILURE_ARTIFACT_IDS = ['failing-test-output', 'stack-trace', 'config-file', 'environment-info', 'repro-steps', 'recent-diff', 'logs'] as const;

const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'local_shell', 'exec_command', 'run_command', 'command', 'PowerShell', 'powershell']);
const AGENT_TOOLS = new Set(['Agent', 'Task', 'spawn_agent', 'task']);
const FAILURE_TEXT_CAP = 20_000;
const SIGNATURE_TEXT_CAP = 2000;

type FailureToolClass = NonNullable<HarnessIntent['failure']>['toolClass'];
type FailureExitClass = NonNullable<HarnessIntent['failure']>['exitClass'];
type FailureElapsed = NonNullable<HarnessIntent['failure']>['elapsed'];
type FailureArtifact = NonNullable<HarnessIntent['failure']>['present'][number];

/** The class of a failed tool, from its name: shell, edit, read, web, agent, mcp, skill, or other. */
export function failureToolClass(toolName: string | null): FailureToolClass {
  if (toolName === null) return 'other';
  if (SHELL_TOOLS.has(toolName)) return 'shell';
  if (AGENT_TOOLS.has(toolName)) return 'agent';
  if (WRITE_TOOL_NAMES.has(toolName)) return 'edit';
  if (FILE_TOOLS.has(toolName)) return 'read';
  if (FETCH_TOOLS.has(toolName)) return 'web';
  if (SKILL_TOOLS.has(toolName)) return 'skill';
  if (/^mcp(?:__|[._:-])/i.test(toolName)) return 'mcp';
  return 'other';
}

/** The exit status a failure's text states (`Exit code 1`, `exit status 2`, `exit 137`), or null. */
function statedExit(text: string): number | null {
  const match = /\bexit(?:ed)?(?: with)?(?: code| status)?\s*[:=]?\s*(\d{1,3})\b/i.exec(text.slice(0, 400));
  return match === null ? null : Number(match[1]);
}

/** Closed exit classes: a timeout or interrupt, a signal (128 and up), a non-zero exit, or an error with no status. */
function failureExitClass(exit: number | null, interrupted: boolean, text: string): FailureExitClass {
  if (interrupted || /\b(?:timed out|timeout|etimedout|deadline exceeded)\b/i.test(text.slice(0, 2000))) return 'timeout';
  const code = exit ?? statedExit(text);
  if (code === null || code === 0) return 'error';
  return code >= 128 || code < 0 ? 'signal' : 'nonzero';
}

/**
 * The environment's failures, not the source's: a missing tool, service, network or permission. The
 * same rule the orchestrator's loop assessment uses (`errorFamily`); a test keeps the two in step.
 */
export const FAILURE_ENVIRONMENT_RULE = /\b(enotfound|econnrefused|econnreset|etimedout|eai_again|command not found|is not recognized as an internal or external command|no such file or directory.*(bin|exe)|enoent.*spawn|permission denied|eacces|cannot connect to the docker daemon|connection refused|service unavailable|could not resolve host|network is unreachable|missing (?:tool|toolchain|sdk))\b/i;

// Line-start whitespace below is spaces and tabs only, never `\s`: that spans newlines, so a long run of blank lines would make a `^`-anchored rule quadratic in the hook.
const TEST_OUTPUT_RULE = /\bnot ok \d+|✖|\bfail(?:ed|ing)? (?:test|spec)|\bassertion(?:error)?\b|\bexpected\b.{0,80}\b(?:received|to equal|to be|but)\b|\b\d+ (?:tests? )?failed\b|^[ \t]*FAIL\b/im;
const STACK_TRACE_RULE = /^[ \t]+at [^\n]*:\d+(?::\d+)?\)?[ \t\r]*$|Traceback \(most recent call last\)|\bpanic: |^goroutine \d+|^[ \t]+File ".*", line \d+/im;
const CONFIG_FILE_RULE = /\b(?:tsconfig|package|composer|pyproject|cargo)\.(?:json|toml)\b|\bgo\.mod\b|\.(?:ya?ml|toml|ini|cfg|conf)\b|\.env\b|\b(?:webpack|vite|jest|vitest|babel|eslint)\.config\b/i;
const ENVIRONMENT_INFO_RULE = /\b(?:node|npm|python|ruby|java|rustc|cargo|go) v?\d+\.\d+(?:\.\d+)?\b|\bplatform\b.{0,40}\b(?:linux|darwin|win32)\b/i;
const LOG_LINES = 15;

/** Which of the fixed vocabulary a failure's own text shows, sorted. The text itself is never kept. */
function failurePresent(text: string): FailureArtifact[] {
  const seen = text.slice(0, FAILURE_TEXT_CAP);
  const present = new Set<FailureArtifact>();
  if (TEST_OUTPUT_RULE.test(seen)) present.add('failing-test-output');
  if (STACK_TRACE_RULE.test(seen)) present.add('stack-trace');
  if (CONFIG_FILE_RULE.test(seen)) present.add('config-file');
  if (ENVIRONMENT_INFO_RULE.test(seen)) present.add('environment-info');
  if (seen.split('\n').filter((line) => line.trim().length > 0).length >= LOG_LINES) present.add('logs');
  return [...present].sort();
}

/** Error text with paths, hex ids, numbers and spacing folded, so the same error with other line numbers matches. */
function normalizedFailureText(text: string): string {
  return text
    .slice(0, FAILURE_TEXT_CAP)
    .toLowerCase()
    .replace(/[a-z]:\\[^\s:]+|\/[^\s:]+/g, '<path>')
    .replace(/0x[0-9a-f]+|[0-9a-f]{8,}/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SIGNATURE_TEXT_CAP);
}

/** A reported duration in milliseconds as a whole, non-negative number; null when absent or odd. */
export function durationOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2 ** 40 ? Math.round(value) : null;
}

function elapsedBucket(durationMs: number | null): FailureElapsed {
  if (durationMs === null || durationMs < 0) return 'unknown';
  return durationMs < 1000 ? 'lt1s' : durationMs < 10_000 ? 'lt10s' : durationMs < 60_000 ? 'lt60s' : 'gte60s';
}

export interface FailureFeatureInput {
  readonly toolName: string | null;
  /** The failed call's input; only its one-way digest is kept. */
  readonly toolInput?: unknown;
  /** The failure's text; only closed codes and a one-way digest of its normalized form are kept. */
  readonly error?: unknown;
  /** The exit status the harness reports (Kilo and OpenCode name it in metadata). */
  readonly exit?: number | null;
  readonly interrupted?: boolean;
  readonly durationMs?: number | null;
}

/**
 * The content-free features of one failed tool call, for `intent.failure`. Never throws; a failure
 * with no text has no signature and none of the text-derived codes.
 */
export function failureFeatures(input: FailureFeatureInput): NonNullable<HarnessIntent['failure']> {
  const text = typeof input.error === 'string' ? input.error : '';
  const toolClass = failureToolClass(input.toolName);
  const exitClass = failureExitClass(input.exit ?? null, input.interrupted === true, text);
  const normalized = normalizedFailureText(text);
  // A call with no input at all has nothing to tell it from another: no digest, never "the same call".
  const identity = isPlainObject(input.toolInput) && Object.keys(input.toolInput).length > 0 ? failureIdentity(input.toolName, input.toolInput) : null;
  return {
    toolClass,
    exitClass,
    family: `${toolClass}:${exitClass}`,
    signature: normalized.length === 0 ? null : sha256Hex(`jevris-failure-v1\n${toolClass}\n${normalized}`).slice(0, 16),
    commandDigest: identity === null ? null : identity.digest,
    environmental: FAILURE_ENVIRONMENT_RULE.test(text.slice(0, FAILURE_TEXT_CAP)),
    elapsed: elapsedBucket(input.durationMs ?? null),
    present: failurePresent(text),
  };
}

// GOV-12 and GOV-13 (C48, C49): what a tool returned, as untrusted text for injection
// screening, and what a tool call proposes to do, for permission-risk triage. Both are advice
// inputs only. The sidecar's bounds: at most 4 spans of 8192 characters, 32768 in all; a command
// of at most 1 KiB; at most 32 paths and 32 hosts.

export const UNTRUSTED_SPAN_CHARS = 8192;
export const UNTRUSTED_SPANS = 4;
export const UNTRUSTED_TOTAL_CHARS = UNTRUSTED_SPAN_CHARS * UNTRUSTED_SPANS;
export const TRUNCATION_MARKER = '\n[truncated by Jevris]';
const EFFECT_COMMAND_CAP = 1024;
const EFFECT_LIST_CAP = 32;
const TEXT_DEPTH = 6;

type SourceKind = HarnessUntrustedIntent['spans'][number]['sourceKind'];

/** Tools that read files, fetch documents or load skills, by the names each harness uses. */
const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'read', 'grep', 'glob', 'list', 'ls', 'view_file', 'view_file_outline', 'view_code_item', 'grep_search', 'find_by_name', 'list_dir', 'codebase_search']);
const FETCH_TOOLS = new Set(['WebFetch', 'WebSearch', 'webfetch', 'websearch', 'web_fetch', 'web_search', 'fetch', 'read_url_content', 'search_web', 'read_browser_page']);
const SKILL_TOOLS = new Set(['Skill', 'skill']);

/** Where a tool's output came from: a file, a fetched document, a skill, else tool output. */
export function untrustedSourceKind(toolName: string | null): SourceKind {
  if (toolName === null) return 'tool-output';
  if (FILE_TOOLS.has(toolName)) return 'file';
  if (FETCH_TOOLS.has(toolName)) return 'fetched-doc';
  if (SKILL_TOOLS.has(toolName)) return 'skill-description';
  return 'tool-output';
}

/** Keys that name things rather than carry returned text. */
const NAME_KEYS = new Set(['type', 'filePath', 'file_path', 'path', 'url', 'id', 'tool_use_id', 'mimeType', 'mime_type', 'encoding', 'title']);

/** The text a tool returned: its string values in order, bounded while collecting. */
function returnedText(value: unknown): string {
  const parts: string[] = [];
  let size = 0;
  const walk = (item: unknown, depth: number): void => {
    if (size > UNTRUSTED_TOTAL_CHARS || depth > TEXT_DEPTH) return;
    if (typeof item === 'string') {
      if (item.trim().length === 0) return;
      parts.push(item);
      size += item.length + 1;
    } else if (Array.isArray(item)) {
      for (const entry of item.slice(0, 256)) walk(entry, depth + 1);
    } else if (isPlainObject(item)) {
      for (const key of Object.keys(item).slice(0, 256)) if (!NAME_KEYS.has(key)) walk(own(item, key), depth + 1);
    }
  };
  walk(value, 0);
  return parts.join('\n');
}

/** Cuts text to at most `max` characters without splitting a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * GOV-12: a finished or failed call's returned text as up to four spans. Longer text is cut and
 * ends with a marker; the event itself is always sent.
 */
export function untrustedIntent(toolName: string | null, toolUseId: string | null, returned: unknown): HarnessUntrustedIntent | null {
  const text = returnedText(returned).trim();
  if (text.length === 0) return null;
  const bounded = text.length <= UNTRUSTED_TOTAL_CHARS ? text : `${cutAt(text, UNTRUSTED_TOTAL_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  const base = toolUseId !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/.test(toolUseId) ? toolUseId : 't1';
  const sourceKind = untrustedSourceKind(toolName);
  const spans: { id: string; sourceKind: SourceKind; text: string }[] = [];
  let rest = bounded;
  while (rest.length > 0 && spans.length < UNTRUSTED_SPANS) {
    const chunk = cutAt(rest, UNTRUSTED_SPAN_CHARS);
    spans.push({ id: spans.length === 0 ? base : `${base}.${spans.length + 1}`, sourceKind, text: chunk });
    rest = rest.slice(chunk.length);
  }
  return { spans };
}

/** The lower-cased host of an http(s) URL, or null. IPv6 literals and odd hosts are left out. */
function urlHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^https?:\/\/(?:[^@/?#\s]*@)?([^:/?#\s]+)/i.exec(value.trim());
  const host = match?.[1]?.toLowerCase() ?? null;
  return host !== null && /^[a-z0-9.-]{1,253}$/.test(host) ? host : null;
}

/** Hosts of the http(s) URLs written in a shell command. */
function commandHosts(command: string): readonly string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/https?:\/\/[^\s'"<>]+/gi)) {
    const host = urlHost(match[0]);
    if (host !== null) out.push(host);
    if (out.length >= EFFECT_LIST_CAP) break;
  }
  return out;
}

/** A shell command as one string (Codex may send an argv array). */
function commandText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(' ');
  return null;
}

/**
 * GOV-13: what a proposed call would do. `args` is the tool's input; the keys cover Claude and
 * Codex (command, file_path, notebook_path, path, url), OpenCode and Kilo (command, filePath,
 * path, url) and Antigravity (CommandLine, TargetFile, AbsolutePath, Url).
 */
export function effectIntent(toolName: string | null, args: Record<string, unknown>): HarnessEffectIntent | null {
  if (toolName === null || !/^[A-Za-z0-9_.:-]{1,64}$/.test(toolName)) return null;
  const rawCommand = commandText(own(args, 'command')) ?? commandText(own(args, 'CommandLine')) ?? commandText(own(args, 'cmd'));
  const patch = [...patchPaths(own(args, 'input')), ...patchPaths(own(args, 'patchText')), ...patchPaths(rawCommand)];
  const paths = new Set<string>();
  for (const candidate of [own(args, 'file_path'), own(args, 'notebook_path'), own(args, 'filePath'), own(args, 'path'), own(args, 'TargetFile'), own(args, 'AbsolutePath'), own(args, 'DirectoryPath'), ...patch]) {
    const path = typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 4096 ? candidate : null;
    if (path !== null) paths.add(path);
    if (paths.size >= EFFECT_LIST_CAP) break;
  }
  const hosts = new Set<string>();
  for (const host of [urlHost(own(args, 'url')), urlHost(own(args, 'Url')), ...(rawCommand === null ? [] : commandHosts(rawCommand))]) {
    if (host !== null) hosts.add(host);
    if (hosts.size >= EFFECT_LIST_CAP) break;
  }
  const command = rawCommand === null || rawCommand.trim().length === 0 ? null : cutAt(rawCommand, EFFECT_COMMAND_CAP);
  return {
    tool: toolName,
    ...(command === null ? {} : { command }),
    ...(paths.size === 0 ? {} : { paths: [...paths] }),
    ...(hosts.size === 0 ? {} : { hosts: [...hosts] }),
  };
}

/** Appended where a string was cut so a native input fits its bound. */
export const CUT_MARKER = ' [cut by Jevris]';

/**
 * A native input as JSON within `cap` bytes, with every string longer than a limit (32768,
 * then 8192, 1024, 256 characters) cut and marked; keys and structure are kept. Null if even
 * that does not fit, or it cannot be serialized.
 */
export function fitWithin(native: unknown, cap: number): string | null {
  const cut = (value: unknown, limit: number, depth: number): unknown => {
    if (typeof value === 'string') return value.length > limit ? `${cutAt(value, limit)}${CUT_MARKER}` : value;
    if (depth > 64 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => cut(item, limit, depth + 1));
    const out: Record<string, unknown> = {};
    // defineProperty keeps a `__proto__` key as an own key, so screening still refuses it.
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) Object.defineProperty(out, key, { value: cut(item, limit, depth + 1), enumerable: true, writable: true, configurable: true });
    return out;
  };
  for (const limit of [32_768, 8192, 1024, 256]) {
    try {
      const text = JSON.stringify(cut(native, limit, 0));
      if (utf8Length(text) <= cap) return text;
    } catch {
      return null;
    }
  }
  return null;
}

/** Collects the present parts. */
export function intentOf(parts: {
  task?: HarnessTaskIntent | null;
  scope?: HarnessScopeIntent | null;
  evidence?: HarnessEvidenceIntent | null;
  failure?: HarnessFailureIntent | null;
  untrusted?: HarnessUntrustedIntent | null;
  effect?: HarnessEffectIntent | null;
}): HarnessIntent {
  return {
    ...(parts.task ? { task: parts.task } : {}),
    ...(parts.scope ? { scope: parts.scope } : {}),
    ...(parts.evidence ? { evidence: parts.evidence } : {}),
    ...(parts.failure ? { failure: parts.failure } : {}),
    ...(parts.untrusted ? { untrusted: parts.untrusted } : {}),
    ...(parts.effect ? { effect: parts.effect } : {}),
  };
}

/** Rejects anything that is not a bounded, plain JSON object with safe keys. */
export function screen(native: unknown): NormalizeRefusal | null {
  if (!isPlainObject(native)) return 'NOT_OBJECT';
  if (hasUnsafeKey(native)) return 'UNSAFE_KEY';
  if (jsonLength(native) > INPUT_CAP) return 'OVER_CAP';
  return null;
}

/** Context text as the harness will see it: trimmed, bounded, never empty. */
export function contextText(outcome: HookOutcome): string | null {
  if (outcome.kind !== 'context' && outcome.kind !== 'explain') return null;
  if (typeof outcome.text !== 'string') return null;
  const text = outcome.text.trim();
  if (text.length === 0) return null;
  return text.length > CONTEXT_CAP ? text.slice(0, CONTEXT_CAP) : text;
}

// VER-05 (SSOT §10.5, US23): one automatic continuation per unchanged missing-evidence
// condition, where the harness's Stop hook can block (Claude Code and Codex). The launcher
// renders it only for a certified reminder, never while `stop_hook_active` is set, and the
// reason names only the missing evidence ids, so no workspace text or secret reaches the prompt.

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * The missing checks a background verification run is still producing, and the launcher's
 * words for them (contracts stillRunningText, the same words as the stop decision's).
 */
export interface StopRunning {
  readonly checkIds: readonly unknown[];
  readonly text: unknown;
}

/** Bound on the still-running words in a Stop block reason (characters). */
const RUNNING_TEXT_CAP = 600;

/**
 * The documented Stop block: `{"decision":"block","reason":...}`; empty when it must not continue.
 * A missing check still running in the background is named as running, not asked for again.
 */
export function stopBlockResponse(event: NormalizedHarnessEvent | null, missingEvidence: readonly unknown[], running?: StopRunning): string {
  if (event === null || event.kind !== 'turn.stopped' || event.nativeEventName !== 'Stop') return '';
  // Only an explicit `false` allows it: a continued turn, or a harness that did not say, never blocks.
  if (event.payload['stopHookActive'] !== false) return '';
  const reason = stopReason(missingEvidence, running);
  return reason === null ? '' : JSON.stringify({ decision: 'block', reason });
}

/**
 * The words of a stop continuation: the missing evidence ids (valid ids only, at most 16) and
 * what to run; a check still running is named as running. Null when no valid id is missing.
 */
export function stopReason(missingEvidence: readonly unknown[], running?: StopRunning): string | null {
  const ids = [...new Set(missingEvidence.filter((id): id is string => typeof id === 'string' && EVIDENCE_ID.test(id)))].slice(0, 16);
  if (ids.length === 0) return null;
  const missing = `Jevris: verification evidence is missing: ${ids.join(', ')}.`;
  const busy = running === undefined ? [] : ids.filter((id) => running.checkIds.includes(id));
  const words = running === undefined ? null : field(running.text, RUNNING_TEXT_CAP);
  if (busy.length === 0 || words === null) return `${missing} Run the declared checks (jevris verify) before finishing.`;
  const rest = ids.filter((id) => !busy.includes(id));
  const next = rest.length > 0 ? `Run the declared checks for ${rest.join(', ')} (jevris verify) before finishing.` : 'Stopping again ends this turn labelled unverified.';
  return `${missing} ${words} ${next}`;
}

// ---------------------------------------------------------------------------
// Subagents. Every harness reports a subagent's event one way: under the parent session
// (`sessionId`), with the subagent's own id in `agentId` and the parent repeated in
// `parentSessionId`. Session-level kinds become worker kinds, so a subagent's prompt, stop,
// compaction or end is never read as the parent's turn, stop or session end. Tool, message and
// file events keep their kinds: they are the subagent's work inside the parent's session.

const SUBAGENT_KINDS: Readonly<Record<string, string>> = {
  'session.started': 'worker.started',
  'task.requested': 'worker.prompted',
  'turn.stopped': 'worker.finished',
  'context.compacting': 'worker.compacting',
  'context.compacted': 'worker.compacted',
  'session.ended': 'worker.ended',
  'turn.failed': 'worker.failed',
};

export interface SubagentScope {
  readonly kind: string;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  /** The parent session for a subagent's event; null for the session's own. */
  readonly parentSessionId: string | null;
}

/**
 * Scopes one event: `sessionId` and `agentId` as the harness reported them, and the parent
 * session when the harness says the event is a subagent's. Without a parent, or with a subagent
 * id equal to the parent's, the event is the session's own and nothing changes.
 */
export function subagentScope(kind: string, sessionId: string | null, agentId: string | null, parentSessionId: string | null): SubagentScope {
  if (parentSessionId === null || agentId === null || agentId === parentSessionId) return { kind, sessionId, agentId, parentSessionId: null };
  return { kind: SUBAGENT_KINDS[kind] ?? kind, sessionId: parentSessionId, agentId, parentSessionId };
}

// ---------------------------------------------------------------------------
// The Claude-compatible command-hook family (Claude Code and Codex).

export interface CommandHookEvent {
  readonly kind: string;
  readonly blocking: boolean;
  readonly responseRequired: boolean;
}

/** Reads the fields both Claude Code and Codex send on every command hook. */
export function commandHookParts(
  harness: HarnessId,
  name: string,
  spec: CommandHookEvent,
  native: Record<string, unknown>,
  context: NormalizeContext = {},
): NormalizeResult {
  const toolInput = own(native, 'tool_input');
  const trigger =
    field(own(native, 'source'), 32) ??
    field(own(native, 'trigger'), 32) ??
    field(own(native, 'reason'), 64) ??
    null;
  const payload = boundedPayload({
    toolInputKeys: keyNames(toolInput),
    toolInputBytes: sizeOf(toolInput),
    toolResponseBytes: sizeOf(own(native, 'tool_response')),
    // A failed call's identity (never its input): a one-way digest, so the same failing call is one
    // approach and different calls with the same argument keys are not.
    ...failureIdentityPayload(spec.kind === 'tool.failed' ? failureIdentity(field(own(native, 'tool_name'), 128), toolInput) : null),
    promptBytes: sizeOf(own(native, 'prompt')),
    lastAssistantMessageBytes: sizeOf(own(native, 'last_assistant_message')),
    stopHookActive: flag(own(native, 'stop_hook_active')),
    agentType: agentTypeField(own(native, 'agent_type')),
    fromModel: field(own(native, 'from_model'), 128),
    toModel: field(own(native, 'to_model'), 128),
    requestedModel: isPlainObject(toolInput) ? requestedModelField(own(toolInput, 'model')) : null,
    // The subagent type a worker tool asks for (Claude Code's Agent/Task and OpenCode's task take
    // subagent_type): a harness label, the only tool-input value that leaves the hook, for C's
    // subagent route (owner decision 9ce2ba5). Never the prompt or the description.
    // Codex's spawn_agent names it agent_type, and a spawn without one runs Codex's "default" role
    // (codex-rs agent/role.rs DEFAULT_ROLE_NAME, 0.157.1).
    subagentType: isPlainObject(toolInput)
      ? (agentTypeField(own(toolInput, 'subagent_type')) ?? (field(own(native, 'tool_name'), 128) === 'spawn_agent' ? (agentTypeField(own(toolInput, 'agent_type')) ?? 'default') : null))
      : null,
    customInstructionsBytes: sizeOf(own(native, 'custom_instructions')),
    effort: isPlainObject(own(native, 'effort')) ? field(own(own(native, 'effort') as object, 'level'), 32) : null,
  });
  const toolName = field(own(native, 'tool_name'), 128);
  const cwd = field(own(native, 'cwd'), 4096);
  const input = isPlainObject(toolInput) ? toolInput : {};
  // Claude Code and Codex send the parent's session_id on a subagent's hooks, with the
  // subagent's agent_id beside it; the parent's own hooks carry no agent_id.
  const sessionId = field(own(native, 'session_id'));
  const agentId = field(own(native, 'agent_id'));
  const scope = subagentScope(spec.kind, sessionId, agentId, agentId === null ? null : sessionId);
  const intent = intentOf({
    task: scope.kind === 'task.requested' ? taskIntent(own(native, 'prompt')) : null,
    scope:
      spec.kind === 'tool.finished' && toolName !== null && WRITE_TOOL_NAMES.has(toolName)
        ? scopeIntent([own(input, 'file_path'), own(input, 'notebook_path'), ...patchPaths(own(input, 'command')), ...patchPaths(own(input, 'input'))], cwd)
        : null,
    evidence: spec.kind === 'tool.failed' ? failureEvidence(toolName, own(native, 'error')) : null,
    // Claude Code's PostToolUseFailure names whether the user interrupted the call and how long it ran.
    failure:
      spec.kind === 'tool.failed'
        ? failureFeatures({ toolName, toolInput, error: own(native, 'error'), interrupted: own(native, 'is_interrupt') === true, durationMs: durationOf(own(native, 'duration_ms')) })
        : null,
    untrusted:
      spec.kind === 'tool.finished'
        ? untrustedIntent(toolName, field(own(native, 'tool_use_id')), own(native, 'tool_response'))
        : spec.kind === 'tool.failed'
          ? untrustedIntent(toolName, field(own(native, 'tool_use_id')), own(native, 'error'))
          : null,
    effect: spec.kind === 'tool.proposed' ? effectIntent(toolName, input) : null,
  });
  return buildEvent({
    harness,
    nativeEventName: name,
    kind: scope.kind,
    intent,
    sessionId: scope.sessionId,
    turnId: field(own(native, 'turn_id')),
    toolUseId: field(own(native, 'tool_use_id')),
    toolName,
    agentId: scope.agentId,
    parentSessionId: scope.parentSessionId,
    model: modelIdField(own(native, 'model')),
    permissionMode: permissionModeField(own(native, 'permission_mode')),
    cwd,
    trigger,
    blocking: spec.blocking,
    responseRequired: spec.responseRequired,
    payload,
    // Claude Code and Codex send no event id on PreCompact, SessionStart or Stop, so the
    // transcript position tells a second compaction (or stop, or repeated prompt) in the same
    // session from a redelivery of the first.
    dedup: [field(own(native, 'prompt_id')), sizeOf(own(native, 'prompt')), field(own(native, 'hook_id')), deliveryPosition(context)],
  });
}

/** The launcher-supplied transcript position, or null when it has none. */
export function deliveryPosition(context: NormalizeContext): number | null {
  const bytes = context.transcriptBytes;
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

export function hookSpecificContext(eventName: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}

// ---------------------------------------------------------------------------
// The OpenCode plugin family (OpenCode and its fork, Kilo).

/** Hook keys the shim registers. Everything else is a bus event delivered through `event`. */
export const PLUGIN_HOOK_KEYS = [
  'event',
  'tool.execute.before',
  'tool.execute.after',
  'chat.message',
  'command.execute.before',
  'experimental.session.compacting',
  // G4: never forwarded. It adds the text the awaited chat.message returned to each model call.
  'experimental.chat.system.transform',
] as const;

/** Claude equivalents: PreToolUse, PostToolUse, UserPromptSubmit (prompt and slash command), PreCompact. */
const PLUGIN_HOOK_KINDS: Readonly<Record<string, string>> = {
  'tool.execute.before': 'tool.proposed',
  'tool.execute.after': 'tool.finished',
  'chat.message': 'task.requested',
  'command.execute.before': 'command.requested',
  'experimental.session.compacting': 'context.compacting',
};

/**
 * Bus events worth forwarding, with their Claude equivalent; the rest (message parts, LSP,
 * TUI, status ticks) are noise for Jevris. `message.updated` is forwarded once per finished
 * assistant message: it names the model that actually answered.
 */
const BUS_KINDS: Readonly<Record<string, string>> = {
  'session.created': 'session.started', // SessionStart
  'session.idle': 'turn.stopped', // Stop
  'message.updated': 'message.completed', // the model per answer (Claude reports it on every hook)
  'session.compacted': 'context.compacted',
  'session.deleted': 'session.ended',
  // A turn that ended on an error (access limits R68): a child session's is its worker's.
  'session.error': 'turn.failed',
  'permission.asked': 'permission.asked',
  'permission.replied': 'permission.replied',
  'file.edited': 'file.edited',
  'command.executed': 'command.executed',
  'todo.updated': 'todo.updated',
  // Only a tool part whose state is `error` (erroredToolPart); every other part is noise.
  'message.part.updated': 'tool.failed',
};

/**
 * G8 (harness parity audit), read from the OpenCode source at v1.18.32 and Kilo at v7.8.1
 * (packages/opencode/src/session/tools.ts, tool/shell.ts, schema v1/session.ts):
 * - A tool that throws never reaches `tool.execute.after`; its part in `message.part.updated`
 *   ends in state `{ status: "error", error }`. That part is a failed call.
 * - The bash tool (id `bash`) returns normally on a non-zero exit, with `metadata.exit` set to
 *   the exit code (null when it timed out or was aborted, which says nothing about success).
 */
function erroredToolPart(part: unknown): { readonly id: string | null; readonly callId: string | null; readonly tool: string | null; readonly error: unknown; readonly input: unknown; readonly durationMs: number | null } | null {
  if (!isPlainObject(part) || own(part, 'type') !== 'tool') return null;
  const state = own(part, 'state');
  if (!isPlainObject(state) || own(state, 'status') !== 'error') return null;
  const time = own(state, 'time');
  const start = isPlainObject(time) ? own(time, 'start') : undefined;
  const end = isPlainObject(time) ? own(time, 'end') : undefined;
  return {
    id: field(own(part, 'id')),
    callId: field(own(part, 'callID')),
    tool: field(own(part, 'tool'), 128),
    error: own(state, 'error'),
    input: own(state, 'input'),
    durationMs: typeof start === 'number' && typeof end === 'number' ? durationOf(end - start) : null,
  };
}

/** A bash `metadata.exit` that is a non-zero exit code. */
function failedExit(tool: string | null, metadata: Record<string, unknown>): boolean {
  const exit = own(metadata, 'exit');
  return tool === 'bash' && typeof exit === 'number' && Number.isSafeInteger(exit) && exit !== 0;
}

function sessionOf(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const direct = field(own(value, 'sessionID')) ?? field(own(value, 'sessionId'));
  if (direct !== null) return direct;
  const info = own(value, 'info');
  if (isPlainObject(info)) return field(own(info, 'sessionID')) ?? field(own(info, 'id'));
  return null;
}

/**
 * The parent session of a child (subagent) session's event: `info.parentID` on the child's own
 * `session.created`, or the `parentSessionID` the shim adds to the child's later events from
 * what it saw there. Kilo and OpenCode name no parent on a child's tool or message events.
 */
/**
 * A child session's type label from its `session.created` title (P13, D). OpenCode's task tool,
 * which Kilo shares, titles the child `<description> (@<agent> subagent)`. Only the agent name is
 * kept, 1 to 64 characters; the description is never read. Null for any other title.
 */
export function subagentTypeOfTitle(title: unknown): string | null {
  if (typeof title !== 'string' || title.length > 4096) return null;
  const match = /\(@([A-Za-z0-9][A-Za-z0-9._-]{0,63}) subagent\)$/.exec(title);
  return match?.[1] ?? null;
}

function parentOf(native: Record<string, unknown>, info: unknown): string | null {
  return (isPlainObject(info) ? field(own(info, 'parentID')) : null) ?? field(own(native, 'parentSessionID'));
}

function modelOf(value: unknown): string | null {
  if (isPlainObject(value)) {
    return field([field(own(value, 'providerID'), 64), field(own(value, 'modelID'), 128)].filter((part) => part !== null).join('/'), 200);
  }
  return field(value, 200);
}

/**
 * A finished assistant message's id, model and token counts (never its text), or null. A message
 * that ended on an error (`info.error`, with or without `time.completed`) is finished too, with
 * the fixed flag `errored: true` and never the error's name or text (B's MEDIUM 25): a failed
 * message is not a success. Its access signal, if any, is the launcher's (R68).
 */
function finishedAssistant(info: unknown): { id: string | null; model: string | null; payload: Record<string, HarnessJson> } | null {
  if (!isPlainObject(info) || own(info, 'role') !== 'assistant') return null;
  const time = own(info, 'time');
  const errored = own(info, 'error') !== undefined && own(info, 'error') !== null;
  if (!errored && (!isPlainObject(time) || typeof own(time, 'completed') !== 'number')) return null;
  const tokens = own(info, 'tokens');
  const read = (key: string): number | null => (isPlainObject(tokens) ? count(own(tokens, key)) : null);
  const payload: Record<string, HarnessJson> = {};
  const entries: ReadonlyArray<readonly [string, HarnessJson | null]> = [
    ['inputTokens', read('input')],
    ['outputTokens', read('output')],
    ['reasoningTokens', read('reasoning')],
    ['agent', field(own(info, 'mode'), 64) ?? field(own(info, 'agent'), 64)],
    ['errored', errored ? true : null],
  ];
  for (const [key, value] of entries) if (value !== null) payload[key] = value;
  return { id: field(own(info, 'id')), model: modelOf(info), payload };
}

/**
 * The shim passes `{ hookKey, input, output }` for a hook call, or the plain `event` argument
 * (`{ event: { type, properties } }`) with hookKey `event`.
 */
export function pluginEvent(harness: HarnessId, native: Record<string, unknown>, hookKey: string | undefined): NormalizeResult {
  const key = hookKey ?? field(own(native, 'hookKey'), 64) ?? (isPlainObject(own(native, 'event')) ? 'event' : null);
  if (key === null) return refuse('MISSING_FIELD', null);
  if (key === 'event') {
    const bus = own(native, 'event');
    if (!isPlainObject(bus)) return refuse('MISSING_FIELD', 'event');
    const type = field(own(bus, 'type'), 64);
    if (type === null) return refuse('MISSING_FIELD', 'event');
    const kind = BUS_KINDS[type];
    if (kind === undefined) return refuse('UNKNOWN_EVENT', type);
    const properties = own(bus, 'properties');
    const props = isPlainObject(properties) ? properties : {};
    const message = type === 'message.updated' ? finishedAssistant(own(props, 'info')) : null;
    if (type === 'message.updated' && message === null) return refuse('UNKNOWN_EVENT', type);
    const failed = type === 'message.part.updated' ? erroredToolPart(own(props, 'part')) : null;
    if (type === 'message.part.updated' && failed === null) return refuse('UNKNOWN_EVENT', type);
    const child = sessionOf(props);
    const scope = subagentScope(kind, child, child, parentOf(native, type === 'session.created' ? own(props, 'info') : null));
    const info = own(props, 'info');
    const childType = type === 'session.created' && scope.parentSessionId !== null && isPlainObject(info) ? subagentTypeOfTitle(own(info, 'title')) : null;
    return buildEvent({
      harness,
      nativeEventName: type,
      kind: scope.kind,
      ...(failed === null
        ? {}
        : {
            intent: intentOf({
              evidence: failureEvidence(failed.tool, failed.error),
              failure: failureFeatures({ toolName: failed.tool, toolInput: failed.input, error: failed.error, durationMs: failed.durationMs }),
              untrusted: untrustedIntent(failed.tool, failed.callId, failed.error),
            }),
          }),
      sessionId: scope.sessionId,
      ...(scope.parentSessionId === null ? {} : { agentId: scope.agentId, parentSessionId: scope.parentSessionId }),
      toolUseId: failed?.callId ?? field(own(props, 'callID')),
      toolName: failed?.tool ?? field(own(props, 'tool'), 128) ?? field(own(props, 'type'), 64),
      model: message?.model ?? null,
      blocking: false,
      responseRequired: false,
      payload: boundedPayload({ propertyKeys: keyNames(props), ...(childType === null ? {} : { agentType: childType }), ...(message === null ? {} : message.payload) }),
      dedup: [field(own(props, 'id')), field(own(props, 'permissionID')), field(own(props, 'file'), 4096), message?.id ?? null, failed?.id ?? null, ...deliveryStamp(native)],
    });
  }
  const kind = PLUGIN_HOOK_KINDS[key];
  if (kind === undefined) return refuse('UNKNOWN_EVENT', key);
  const input = own(native, 'input');
  const output = own(native, 'output');
  if (!isPlainObject(input)) return refuse('MISSING_FIELD', key);
  const model = modelOf(own(input, 'model'));
  const outputObject = isPlainObject(output) ? output : {};
  const tool = field(own(input, 'tool'), 128);
  const args = isPlainObject(own(input, 'args')) ? (own(input, 'args') as Record<string, unknown>) : isPlainObject(own(outputObject, 'args')) ? (own(outputObject, 'args') as Record<string, unknown>) : {};
  const metadata = isPlainObject(own(outputObject, 'metadata')) ? (own(outputObject, 'metadata') as Record<string, unknown>) : {};
  const agentName = field(own(input, 'agent'), 128);
  const child = sessionOf(input);
  const exitFailed = key === 'tool.execute.after' && failedExit(tool, metadata);
  const scope = subagentScope(exitFailed ? 'tool.failed' : kind, child, child, parentOf(native, null));
  const subagent = scope.parentSessionId !== null;
  const intent = intentOf({
    task: scope.kind === 'task.requested' ? taskIntent(promptText(own(outputObject, 'parts'))) : null,
    scope:
      key === 'tool.execute.after' && tool !== null && WRITE_TOOL_NAMES.has(tool)
        ? scopeIntent([own(args, 'filePath'), own(metadata, 'filepath'), own(metadata, 'filePath'), ...patchPaths(own(args, 'patchText'))], null)
        : null,
    evidence: exitFailed ? failureEvidence(tool, own(outputObject, 'output')) : null,
    // A bash call's non-zero exit status is in its metadata; a timed-out or aborted one has none.
    failure: exitFailed ? failureFeatures({ toolName: tool, toolInput: args, error: own(outputObject, 'output'), exit: count(own(metadata, 'exit')) }) : null,
    untrusted: key === 'tool.execute.after' ? untrustedIntent(tool, field(own(input, 'callID')), own(outputObject, 'output')) : null,
    effect: key === 'tool.execute.before' ? effectIntent(tool, args) : null,
  });
  return buildEvent({
    harness,
    nativeEventName: key,
    kind: scope.kind,
    intent,
    sessionId: scope.sessionId,
    toolUseId: field(own(input, 'callID')),
    toolName: tool ?? (key === 'command.execute.before' ? field(own(input, 'command'), 128) : null),
    // A subagent is named by its child session, as Claude and Codex name one by agent_id; the
    // agent it runs as moves to payload.agentType.
    agentId: subagent ? scope.agentId : agentName,
    parentSessionId: scope.parentSessionId,
    model,
    blocking: true,
    responseRequired: false,
    payload: boundedPayload({
      agentType: subagent ? field(agentName, 64) : null,
      argKeys: keyNames(own(outputObject, 'args')),
      argBytes: sizeOf(own(outputObject, 'args')),
      outputBytes: sizeOf(own(outputObject, 'output')),
      partCount: Array.isArray(own(outputObject, 'parts')) ? (own(outputObject, 'parts') as unknown[]).length : null,
      contextCount: Array.isArray(own(outputObject, 'context')) ? (own(outputObject, 'context') as unknown[]).length : null,
      argumentBytes: key === 'command.execute.before' ? sizeOf(own(input, 'arguments')) : null,
      // The task tool's subagent type and any model it already names, for C's subagent route
      // (R20); never its prompt or description.
      subagentType: key === 'tool.execute.before' && tool === 'task' ? agentTypeField(own(args, 'subagent_type')) : null,
      requestedModel: key === 'tool.execute.before' && tool === 'task' ? requestedModelField(own(args, 'model')) : null,
    }),
    dedup: [field(own(input, 'messageID')), ...deliveryStamp(native)],
  });
}

/** A chat message's typed text parts joined, never synthetic or ignored parts; null without any. */
function promptText(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const texts: string[] = [];
  for (const part of parts.slice(0, 64)) {
    if (!isPlainObject(part) || own(part, 'type') !== 'text' || own(part, 'synthetic') === true || own(part, 'ignored') === true) continue;
    const text = own(part, 'text');
    if (typeof text === 'string' && text.trim().length > 0) texts.push(text);
  }
  return texts.length === 0 ? null : texts.join('\n');
}

/**
 * The shim's stamp for one delivery: its instance and a sequence number. Bus events such as
 * `session.idle` and `session.compacted`, and the compacting hook, carry no event id, so without
 * it a second compaction or idle in a session would be dropped as a duplicate. The same event
 * object delivered twice keeps its stamp, so a redelivery still dedups.
 */
function deliveryStamp(native: Record<string, unknown>): readonly (string | number | null)[] {
  const stamp = own(native, 'delivery');
  if (!isPlainObject(stamp)) return [];
  const seq = own(stamp, 'seq');
  return [field(own(stamp, 'instance'), 64), typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null];
}

/**
 * In-process plugins render a mutation the shim applies, or nothing:
 * - compaction: `{"context":[...]}`, context lines only;
 * - a person's message (chat.message, audit G4): `{"system":[...]}`, context or an explanation.
 *   The shim keeps it for that session and adds it to the system prompt of each model call in
 *   the turn, through `experimental.chat.system.transform`;
 * - a subagent route (routing design R20, owner decision OD-7) on `tool.execute.before` of the
 *   `task` tool: `{"route":{"providerID","modelID","variant"}}`, and only when the call names no
 *   model, provider or variant of its own (a pin). The task tool does not apply a model argument
 *   (Kilo's ignores args.model on the owner's certify run, 2026-09-28; OpenCode's takes none), so
 *   the shim writes the route to the child session's first message. The route arrives only when
 *   `hooks.route` is certified for this harness version, which needs the harness's subagent-route
 *   certify case.
 */
export function pluginResponse(event: NormalizedHarnessEvent | null, outcome: HookOutcome, native?: unknown): string {
  if (event === null) return '';
  if (outcome.kind === 'route') {
    const route = native === undefined ? null : taskRouteOf(event, outcome, native);
    return route === null ? '' : JSON.stringify({ route });
  }
  if (event.nativeEventName === 'experimental.session.compacting') {
    if (outcome.kind !== 'context') return '';
    const text = contextText(outcome);
    return text === null ? '' : JSON.stringify({ context: [text] });
  }
  if (event.nativeEventName === 'chat.message') {
    const text = contextText(outcome);
    return text === null ? '' : JSON.stringify({ system: [text] });
  }
  return '';
}

/** A Kilo or OpenCode provider id and model id as their plugin APIs take them (E's route-turn contract). */
const PLUGIN_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLUGIN_MODEL_ID = /^(?:[a-z0-9][a-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$/;
const PLUGIN_VARIANT = /^[a-z][a-z0-9-]{0,31}$/;
/** Task arguments that pin the subagent's model: a call naming any of them is never routed. */
export const TASK_PIN_KEYS = ['model', 'provider', 'variant'] as const;

/** A route the shim may write: a plugin provider id, model id and optional variant. */
export interface PluginRoute {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant: string | null;
}

/** Splits a harness `provider/model` id on its first slash (C's spelling); null when either part is malformed. */
export function pluginRouteOf(model: unknown, variant: unknown): PluginRoute | null {
  if (typeof model !== 'string') return null;
  const at = model.indexOf('/');
  if (at <= 0) return null;
  const providerID = model.slice(0, at);
  const modelID = model.slice(at + 1);
  if (!PLUGIN_PROVIDER_ID.test(providerID) || !PLUGIN_MODEL_ID.test(modelID)) return null;
  if (variant !== undefined && variant !== null && (typeof variant !== 'string' || !PLUGIN_VARIANT.test(variant))) return null;
  return { providerID, modelID, variant: typeof variant === 'string' ? variant : null };
}

/** The route for a task call that names no model of its own, or null. */
function taskRouteOf(event: NormalizedHarnessEvent, outcome: Extract<HookOutcome, { kind: 'route' }>, native: unknown): PluginRoute | null {
  if (event.nativeEventName !== 'tool.execute.before' || event.toolName !== 'task') return null;
  if (!isPlainObject(native) || own(native, 'hookKey') !== 'tool.execute.before') return null;
  const input = own(native, 'input');
  const output = own(native, 'output');
  if (!isPlainObject(input) || own(input, 'tool') !== 'task' || !isPlainObject(output)) return null;
  const args = own(output, 'args');
  if (!isPlainObject(args) || TASK_PIN_KEYS.some((key) => Object.hasOwn(args, key))) return null;
  return pluginRouteOf(outcome.model, outcome.variant);
}

// ---------------------------------------------------------------------------
// In-process plugin hooks (Kilo and OpenCode shims).

/**
 * A delivery the shim lost before the launcher could count it (audit G16): dropped because 8
 * calls were in flight, the launcher did not start, the shim stopped waiting, or the launcher
 * was killed at its hard timeout.
 */
export type ShimMissCode = 'SHIM_DROPPED' | 'SHIM_TIMEOUT' | 'SHIM_SPAWN_FAILED' | 'SHIM_KILLED';
export type ShimMissSink = (reasonCode: ShimMissCode, elapsedMs: number) => void;
/** Misses of one kind since the last delivery that carried them: a count and the longest wait. */
export interface ShimMiss {
  readonly reasonCode: ShimMissCode;
  readonly count: number;
  readonly maxMs: number;
}
const SHIM_MISS_COUNT_CAP = 1_000_000;
const SHIM_MISS_MS_CAP = 3_600_000;

/**
 * Sends one native event to the hook launcher; resolves to its stdout, '' on any failure. A
 * forwarder that knows why a call failed tells `onMiss` once (spawn failure or kill).
 */
export type PluginForward = (nativeJson: string, awaitResponse: boolean, onMiss?: ShimMissSink) => Promise<string>;

export interface PluginHookOptions {
  readonly harness: HarnessId;
  readonly forward: PluginForward;
  /** How long a compaction hook waits for context before it gives up (ms). */
  readonly responseTimeoutMs?: number;
  /**
   * How long a top-level session's chat.message waits for the text to show on that turn (ms,
   * audit G4). The person's message waits this long at most; a miss adds nothing.
   */
  readonly messageTimeoutMs?: number;
  /** Fire-and-forget calls allowed at once; later ones are dropped, never queued. */
  readonly maxInFlight?: number;
  /**
   * The project config check a route needs (projectConfigGuard). Absent: no route is ever
   * written, as when the check says no.
   */
  readonly projectConfig?: ProjectConfigCheck;
}

/** Adds or refreshes one entry of a bounded map; the oldest entry goes first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > PARENT_MEMORY) {
    const oldest = map.keys().next();
    if (oldest.done !== true) map.delete(oldest.value);
  }
}

/** A task call's route, held for the child session the task tool starts next (R20). */
interface HeldRoute {
  readonly route: PluginRoute | null;
  readonly subagentType: string | null;
  readonly calls: Set<string>;
}

export type PluginHook = (input: unknown, output?: unknown) => Promise<void>;
export type PluginHooks = { readonly [key: string]: PluginHook };

function withTimeout(promise: Promise<string>, ms: number, onTimeout?: () => void): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        onTimeout?.();
        resolve('');
      }
    }, ms);
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(typeof value === 'string' ? value : '');
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve('');
      },
    );
  });
}

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** The text a chat.message response asks the shim to show on that turn (G4); at most 8 lines. */
export function systemLinesOf(response: string): string[] {
  if (response.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.system)) return [];
  const lines: string[] = [];
  for (const line of parsed.system.slice(0, 8)) {
    if (typeof line !== 'string' || line.trim().length === 0) continue;
    lines.push(line.length > CONTEXT_CAP ? line.slice(0, CONTEXT_CAP) : line);
  }
  return lines;
}

/** Applies a launcher response to a compaction hook's output: only `output.context` lines. */
export function applyPluginResponse(output: unknown, response: string): boolean {
  if (response.length === 0 || !isPlainObject(output)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.context)) return false;
  const target = own(output, 'context');
  if (!Array.isArray(target)) return false;
  let added = false;
  for (const line of parsed.context.slice(0, 8)) {
    if (typeof line !== 'string' || line.trim().length === 0) continue;
    target.push(line.length > CONTEXT_CAP ? line.slice(0, CONTEXT_CAP) : line);
    added = true;
  }
  return added;
}

/** The route a launcher answer names for a task call (`{"route":{...}}`), re-checked; null otherwise. */
export function routeResponseOf(response: string): PluginRoute | null {
  const parsed = parsedObject(response);
  if (parsed === null || Object.keys(parsed).join() !== 'route') return null;
  const route = own(parsed, 'route');
  if (!isPlainObject(route) || Object.keys(route).some((key) => key !== 'providerID' && key !== 'modelID' && key !== 'variant')) return null;
  const providerID = own(route, 'providerID');
  const modelID = own(route, 'modelID');
  if (typeof providerID !== 'string' || !PLUGIN_PROVIDER_ID.test(providerID) || typeof modelID !== 'string' || !PLUGIN_MODEL_ID.test(modelID)) return null;
  const variant = own(route, 'variant');
  if (variant !== undefined && variant !== null && (typeof variant !== 'string' || !PLUGIN_VARIANT.test(variant))) return null;
  return { providerID, modelID, variant: typeof variant === 'string' ? variant : null };
}

function parsedObject(text: string): Record<string, unknown> | null {
  if (text.length === 0 || text.length > 65_536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isPlainObject(parsed) && !hasUnsafeKey(parsed) ? parsed : null;
}

const TURN_MODES: ReadonlySet<string> = new Set(['advice-only', 'plugin-bounded-auto', 'owned-sdk-approved']);
const TURN_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const TURN_KEYS: ReadonlySet<string> = new Set(['harness', 'mainSession', 'outcome', 'actuate', 'reasonCode', 'text', 'model', 'variant']);

/**
 * The shim's own check of a `route.turn` answer: E's RouteTurnPayloadContract, re-implemented
 * because the shim imports nothing (a test cross-checks the two). It does not re-run the
 * contract's secret and URL checks on `text`, which the shim never shows. Returns the switch to
 * write only when the answer actuates; anything else, valid or not, writes nothing.
 */
export function turnPayloadRoute(harness: HarnessId, payload: unknown): PluginRoute | null {
  if (harness !== 'kilocode' && harness !== 'opencode') return null;
  if (!isPlainObject(payload) || Object.keys(payload).some((key) => !TURN_KEYS.has(key)) || own(payload, 'harness') !== harness) return null;
  const main = own(payload, 'mainSession');
  if (!isPlainObject(main) || Object.keys(main).some((key) => key !== 'mode' && key !== 'switched')) return null;
  const mode = own(main, 'mode');
  const switched = own(main, 'switched');
  const outcome = own(payload, 'outcome');
  const actuate = own(payload, 'actuate');
  const reasonCode = own(payload, 'reasonCode');
  const text = own(payload, 'text');
  if (typeof mode !== 'string' || !TURN_MODES.has(mode) || typeof switched !== 'boolean' || typeof actuate !== 'boolean') return null;
  if ((outcome !== 'switch' && outcome !== 'abstain') || typeof reasonCode !== 'string' || !TURN_REASON.test(reasonCode)) return null;
  if (typeof text !== 'string' || text.length === 0 || text.length > 500) return null;
  const model = own(payload, 'model');
  const variant = own(payload, 'variant');
  let named: { readonly providerID: string; readonly modelID: string } | null = null;
  if (model !== undefined) {
    if (!isPlainObject(model) || Object.keys(model).some((key) => key !== 'providerID' && key !== 'modelID')) return null;
    const providerID = own(model, 'providerID');
    const modelID = own(model, 'modelID');
    if (typeof providerID !== 'string' || !PLUGIN_PROVIDER_ID.test(providerID) || typeof modelID !== 'string' || !PLUGIN_MODEL_ID.test(modelID)) return null;
    named = { providerID, modelID };
  }
  if (variant !== undefined && variant !== null && (typeof variant !== 'string' || !PLUGIN_VARIANT.test(variant))) return null;
  // The contract's own rules (route-turn.ts refine).
  if (switched !== actuate) return null;
  if (actuate && (mode !== 'plugin-bounded-auto' || outcome !== 'switch')) return null;
  if (outcome === 'switch' && named === null) return null;
  if (outcome === 'abstain' && (named !== null || (variant !== undefined && variant !== null))) return null;
  if (!actuate || named === null) return null;
  return { ...named, variant: typeof variant === 'string' ? variant : null };
}

/**
 * The switch a launcher answer carries for one top-level turn, `{"turn":{sessionId, messageId,
 * payload}}`: only when the ids are the ones this turn asked with (B's review, LOW 12) and the
 * payload passes turnPayloadRoute. Null writes nothing.
 */
export function turnResponseOf(harness: HarnessId, response: string, expected: { readonly sessionId: string; readonly messageId: string | null }): PluginRoute | null {
  const parsed = parsedObject(response);
  const turn = parsed === null ? undefined : own(parsed, 'turn');
  if (!isPlainObject(turn) || Object.keys(turn).some((key) => key !== 'sessionId' && key !== 'messageId' && key !== 'payload')) return null;
  if (own(turn, 'sessionId') !== expected.sessionId || (own(turn, 'messageId') ?? null) !== expected.messageId) return null;
  return turnPayloadRoute(harness, own(turn, 'payload'));
}

/** Writes the route to a message's model (`output.message.model`), and nothing else. */
export function applyMessageModel(output: unknown, route: PluginRoute): boolean {
  if (!isPlainObject(output)) return false;
  const message = own(output, 'message');
  if (!isPlainObject(message)) return false;
  message['model'] = route.variant === null ? { providerID: route.providerID, modelID: route.modelID } : { providerID: route.providerID, modelID: route.modelID, variant: route.variant };
  return true;
}

/**
 * The model a chat.message turn resolved to: the harness's own `output.message.model`
 * (`{providerID, modelID, variant}`, OpenCode session/prompt.ts and Kilo's), never `input.model`,
 * which is only the model the caller passed and is undefined when the turn names none (serving-host
 * design R53). Null when the resolved message names no model.
 */
export function resolvedTurnModel(output: unknown): { readonly providerID: string; readonly modelID: string; readonly variant: string | null } | null {
  const message = isPlainObject(output) ? own(output, 'message') : undefined;
  const model = isPlainObject(message) ? own(message, 'model') : undefined;
  if (!isPlainObject(model)) return null;
  const providerID = field(own(model, 'providerID'), 64);
  const modelID = field(own(model, 'modelID'), 200);
  if (providerID === null || modelID === null) return null;
  return { providerID, modelID, variant: field(own(model, 'variant'), 64) };
}

/** A turn's resolved model and variant as one comparable key; null when it names none. */
export function turnModelKey(output: unknown): string | null {
  const model = resolvedTurnModel(output);
  return model === null ? null : JSON.stringify([model.providerID, model.modelID, model.variant]);
}

/** A turn's message id: the caller's `messageID`, else the id the harness gave the resolved message. */
export function turnMessageId(input: unknown, output: unknown): string | null {
  const given = isPlainObject(input) ? field(own(input, 'messageID')) : null;
  if (given !== null) return given;
  const message = isPlainObject(output) ? own(output, 'message') : undefined;
  return isPlainObject(message) ? field(own(message, 'id')) : null;
}

// ---------------------------------------------------------------------------
// Project configuration (B's review, MEDIUM 10): a route never goes to a provider that the
// project's own config redefines (a baseURL, options or models redirect).

/** The largest project config file the check reads; anything larger counts as unreadable. */
export const PROJECT_CONFIG_CAP = 262_144;
/** How long a route waits for the project config check; a miss writes nothing. */
export const PROJECT_CONFIG_TIMEOUT_MS = 200;

/** Answers whether a route to `providerID` may be written: false when in any doubt. */
export type ProjectConfigCheck = (providerID: string) => Promise<boolean>;

interface StatLike {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
}
/** The filesystem and path calls the check uses (node:fs/promises and node:path, or a test's). */
export interface ProjectConfigHost {
  readonly fs: {
    lstat(path: string): Promise<StatLike>;
    stat(path: string): Promise<StatLike>;
    realpath(path: string): Promise<string>;
    readFile(path: string, encoding: 'utf8'): Promise<string>;
  };
  readonly path: {
    resolve(...parts: string[]): string;
    join(...parts: string[]): string;
    dirname(path: string): string;
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
  };
}

/**
 * The project config files each harness loads at one folder level, from `directory` up to the
 * worktree root. OpenCode (1.18.32 config/paths.ts, config.ts): `opencode.json[c]` and
 * `.opencode/opencode.json[c]`. Kilo (kilocode/config/config.ts ALL_CONFIG_FILES, config
 * directories `.kilo` and `.kilocode`): `kilo.json[c]` and `opencode.json[c]`, at the level and in
 * both directories. The user's global config is trusted and not read.
 */
export function projectConfigFiles(harness: HarnessId, level: string, join: (...parts: string[]) => string): string[] {
  if (harness === 'opencode') {
    const names = ['opencode.jsonc', 'opencode.json'];
    return [...names.map((name) => join(level, name)), ...names.map((name) => join(level, '.opencode', name))];
  }
  if (harness === 'kilocode') {
    const names = ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json'];
    return ['', '.kilo', '.kilocode'].flatMap((dir) => names.map((name) => (dir === '' ? join(level, name) : join(level, dir, name))));
  }
  return [];
}

/** JSON with comments and trailing commas (the harnesses' .jsonc), or undefined when it does not parse. */
export function parseJsonc(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let stripped = '';
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] as string;
    if (inString) {
      stripped += c;
      if (c === '\\') {
        stripped += source[i + 1] ?? '';
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      stripped += c;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      stripped += '\n';
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      i = end + 1;
      stripped += ' ';
    } else stripped += c;
  }
  if (inString) return undefined;
  let clean = '';
  inString = false;
  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i] as string;
    if (inString) {
      clean += c;
      if (c === '\\') {
        clean += stripped[i + 1] ?? '';
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ',') {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j] as string)) j += 1;
      if (stripped[j] === '}' || stripped[j] === ']') continue;
    }
    clean += c;
  }
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return undefined;
  }
}

function isMissing(error: unknown): boolean {
  const code = isPlainObject(error) || (error !== null && typeof error === 'object') ? Reflect.get(error as object, 'code') : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The project config check for one plugin instance (`directory` and `worktree` from the harness's
 * PluginInput). A route to `providerID` is allowed only when no project config file from
 * `directory` up to the worktree root defines `provider.<providerID>`, every such file that exists
 * is a regular file of at most 256 KiB that parses, and each resolves (through any link) inside
 * the worktree. Kilo also loads the primary checkout's config for a linked git worktree, which
 * this check does not follow, so a linked worktree (`.git` is a file) is refused. Any error
 * refuses.
 *
 * The harnesses substitute `{env:NAME}` and `{file:path}` over a config's raw text before parsing
 * it, keys included, so a key such as `"{file:./p}"` can become a provider id, or `provider`
 * itself, that this check never sees. A file whose raw text holds `{env:` or `{file:` anywhere,
 * comments included, refuses every route (B's review, MEDIUM 13).
 *
 * The files are read twice: once when the plugin loads, as the harness did, and again at each
 * route. A refusal found at load time holds for the plugin's life, so a file removed after the
 * harness loaded it cannot lift it (B's review, LOW 15).
 */
export function projectConfigGuard(harness: HarnessId, roots: { readonly directory: unknown; readonly worktree: unknown }, loadHost: () => Promise<ProjectConfigHost | null>): ProjectConfigCheck {
  /** The provider ids the project configs define, or null when any doubt refuses every route. */
  const scan = async (): Promise<ReadonlySet<string> | null> => {
    try {
      const host = await loadHost();
      if (host === null) return null;
      const { fs, path } = host;
      const { directory, worktree } = roots;
      if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
      const start = path.resolve(directory);
      const stop = typeof worktree === 'string' && path.isAbsolute(worktree) ? path.resolve(worktree) : start;
      const realStop = await fs.realpath(stop);
      const inside = (target: string): boolean => {
        const rel = path.relative(realStop, target);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      };
      if (harness === 'kilocode') {
        try {
          if ((await fs.lstat(path.join(stop, '.git'))).isFile()) return null;
        } catch (error) {
          if (!isMissing(error)) return null;
        }
      }
      const levels: string[] = [];
      for (let level = start, i = 0; i < 64; i += 1) {
        levels.push(level);
        const up = path.dirname(level);
        if (level === stop || up === level) break;
        level = up;
      }
      const defined = new Set<string>();
      for (const level of levels) {
        for (const file of projectConfigFiles(harness, level, path.join)) {
          try {
            await fs.lstat(file);
          } catch (error) {
            if (isMissing(error)) continue;
            return null;
          }
          const real = await fs.realpath(file);
          if (!inside(real)) return null;
          const stat = await fs.stat(real);
          if (!stat.isFile() || stat.size > PROJECT_CONFIG_CAP) return null;
          const text = await fs.readFile(real, 'utf8');
          if (text.includes('{env:') || text.includes('{file:')) return null;
          const parsed = parseJsonc(text);
          if (!isPlainObject(parsed)) return null;
          const provider = own(parsed, 'provider');
          if (provider === undefined) continue;
          if (!isPlainObject(provider)) return null;
          for (const key of Object.keys(provider)) defined.add(key);
        }
      }
      return defined;
    } catch {
      return null;
    }
  };
  const allows = (defined: ReadonlySet<string> | null, providerID: string): boolean => defined !== null && !defined.has(providerID);
  const atLoad = scan();
  return async (providerID) => {
    try {
      if (!PLUGIN_PROVIDER_ID.test(providerID)) return false;
      if (!allows(await atLoad, providerID)) return false;
      return allows(await scan(), providerID);
    } catch {
      return false;
    }
  };
}

/** The real host for projectConfigGuard: node:fs/promises and node:path, loaded when first needed. */
export async function nodeConfigHost(): Promise<ProjectConfigHost | null> {
  try {
    const fs = (await import('node:fs/promises' as string)) as ProjectConfigHost['fs'];
    const path = (await import('node:path' as string)) as ProjectConfigHost['path'];
    return { fs, path };
  } catch {
    return null;
  }
}

/**
 * The hook object a Kilo or OpenCode shim returns. Every hook normalizes first and forwards
 * only recognised events. Only two waits exist:
 * - compaction waits at most `responseTimeoutMs`, then adds context lines only;
 * - a top-level session's chat.message waits at most `messageTimeoutMs` (G4). The text it
 *   returns is kept for that session and added to `output.system` by
 *   `experimental.chat.system.transform` on each model call of the turn, with no spawn and no
 *   wait. It is cleared by the next chat.message, and when the session idles or is deleted.
 * A failed or slow launcher is a no-op. No hook ever throws, blocks a tool or writes a
 * permission field.
 *
 * Routes (routing design R20 and OD-8; B's review, MEDIUM 10 and LOW 12). Only a model is ever
 * written, to a message's `output.message.model`. Nothing else in the output and nothing in any
 * configuration changes.
 * Each needs a session the shim saw start (its `session.created`), a route that re-checks, and a
 * project config that does not redefine the target provider (projectConfigGuard); any doubt,
 * error or timeout writes nothing.
 * - A subagent (`task` call with no model, provider or variant of its own) waits at most
 *   `messageTimeoutMs` for the launcher's `route`. The task tool applies no model argument, so
 *   the route is held for the one child session that call starts and written to that child's
 *   first message, only when the child still runs on its parent's turn model (an agent with its
 *   own configured model is a pin), runs as the agent the call asked for, and no second task call
 *   of the same parent is in flight.
 * - A top-level turn asks `route.turn` through the launcher, in parallel with its event, and
 *   writes the answer only when it actuates and names this turn's session and message. OpenCode
 *   and Kilo store the session's model before this hook runs (session/prompt.ts, setAgentModel
 *   before the chat.message trigger), so only that turn changes. The turn's model is the one the
 *   harness resolved, `output.message.model`, read before anything is written (R53); `input.model`
 *   is undefined when the turn names none. A turn whose resolved model differs from the previous
 *   turn's is the person's own choice: that turn and the rest of the session are never switched.
 *   The first turn the shim sees in a session is never switched either.
 *
 * A delivery lost on the shim side is counted (audit G16): at most one miss per delivery, kept
 * as a count and the longest wait per reason code, and carried as the top-level `shimMisses`
 * of the next event that reaches the launcher, which writes them to the hook-latency file.
 */
export function createPluginHooks(options: PluginHookOptions): PluginHooks {
  const timeoutMs = options.responseTimeoutMs ?? 1500;
  const messageTimeoutMs = options.messageTimeoutMs ?? MESSAGE_TIMEOUT_MS;
  const maxInFlight = options.maxInFlight ?? 8;
  let inFlight = 0;
  const misses = new Map<ShimMissCode, { count: number; maxMs: number }>();
  const noteMiss = (reasonCode: ShimMissCode, elapsedMs: number, count = 1): void => {
    const ms = Math.min(SHIM_MISS_MS_CAP, Math.max(0, Math.round(Number.isFinite(elapsedMs) ? elapsedMs : 0)));
    const known = misses.get(reasonCode);
    if (known === undefined) misses.set(reasonCode, { count: Math.min(SHIM_MISS_COUNT_CAP, count), maxMs: ms });
    else {
      known.count = Math.min(SHIM_MISS_COUNT_CAP, known.count + count);
      known.maxMs = Math.max(known.maxMs, ms);
    }
  };
  const takeMisses = (): ShimMiss[] | null => {
    if (misses.size === 0) return null;
    const list: ShimMiss[] = [];
    for (const [reasonCode, value] of misses) list.push({ reasonCode, count: value.count, maxMs: value.maxMs });
    misses.clear();
    return list;
  };
  const restoreMisses = (list: readonly ShimMiss[] | null): void => {
    for (const item of list ?? []) noteMiss(item.reasonCode, item.maxMs, item.count);
  };
  // One stamp per delivered event object (see deliveryStamp). A new instance id per shim load
  // keeps a resumed session's sequence apart from the previous process's.
  const instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const stamps = new WeakMap<object, number>();
  let seq = 0;
  const stampOf = (value: unknown): { readonly instance: string; readonly seq: number } => {
    if (value !== null && typeof value === 'object') {
      const known = stamps.get(value);
      if (known !== undefined) return { instance, seq: known };
      seq += 1;
      stamps.set(value, seq);
      return { instance, seq };
    }
    seq += 1;
    return { instance, seq };
  };
  // Child (subagent) session id to its parent, learned from the child's session.created. Kilo
  // and OpenCode name no parent on a child's later events, so the shim adds it. Bounded: the
  // oldest entry goes first.
  const parents = new Map<string, string>();
  const parentFor = (hookKey: string, input: unknown): string | null => {
    if (hookKey !== 'event') return isPlainObject(input) ? (parents.get(sessionOf(input) ?? '') ?? null) : null;
    const bus = isPlainObject(input) ? own(input, 'event') : null;
    if (!isPlainObject(bus)) return null;
    const props = own(bus, 'properties');
    const child = sessionOf(props);
    if (child === null) return null;
    const info = isPlainObject(props) ? own(props, 'info') : null;
    const parent = own(bus, 'type') === 'session.created' && isPlainObject(info) ? field(own(info, 'parentID')) : null;
    if (parent !== null && parent !== child && !parents.has(child)) {
      parents.set(child, parent);
      if (parents.size > PARENT_MEMORY) {
        const oldest = parents.keys().next();
        if (oldest.done !== true) parents.delete(oldest.value);
      }
    }
    return parents.get(child) ?? null;
  };
  // G4: the text each top-level session shows on its current turn. Bounded: the oldest goes first.
  const shown = new Map<string, readonly string[]>();
  const keepShown = (session: string, lines: readonly string[]): void => {
    shown.delete(session);
    if (lines.length === 0) return;
    shown.set(session, lines);
    if (shown.size > PARENT_MEMORY) {
      const oldest = shown.keys().next();
      if (oldest.done !== true) shown.delete(oldest.value);
    }
  };
  // Routes: sessions seen start at the top level, each with its last turn input and whether its
  // person changed the model (one record, so an eviction drops both and a session with no record
  // never asks; B's review, LOW 14); the model each session's turn runs on; and task routes held
  // for the child session they start. All bounded like `parents`.
  const tops = new Map<string, { readonly lastInput: string | null; readonly changed: boolean }>();
  const turnModel = new Map<string, { readonly providerID: string; readonly modelID: string }>();
  const held = new Map<string, HeldRoute>();
  const childRoutes = new Map<string, { readonly route: PluginRoute; readonly subagentType: string | null }>();
  const forget = (session: string): void => {
    for (const map of [tops, turnModel, held, childRoutes, shown] as Map<string, unknown>[]) map.delete(session);
  };
  const allowed = (providerID: string): Promise<boolean> => {
    const check = options.projectConfig;
    if (check === undefined) return Promise.resolve(false);
    let call: Promise<boolean>;
    try {
      call = check(providerID);
    } catch {
      return Promise.resolve(false);
    }
    return withTimeout(call.then((ok) => (ok === true ? 'yes' : '')), PROJECT_CONFIG_TIMEOUT_MS).then((answer) => answer === 'yes');
  };
  const send = (hookKey: string, input: unknown, output: unknown, awaited = false, extra: Record<string, unknown> = {}): Promise<string> | null => {
    const delivery = stampOf(input);
    const parent = parentFor(hookKey, input);
    const link = parent === null ? {} : { parentSessionID: parent };
    const native: Record<string, unknown> = hookKey === 'event' && isPlainObject(input) ? { ...input, hookKey, delivery, ...link } : { hookKey, input, output, delivery, ...link, ...extra };
    const normalized = hookKey === 'event' ? pluginEvent(options.harness, native, 'event') : pluginEvent(options.harness, native, hookKey);
    if (!normalized.ok) return null;
    const wait = hookKey === 'experimental.session.compacting' || awaited;
    if (!wait && inFlight >= maxInFlight) {
      noteMiss('SHIM_DROPPED', 0);
      return null;
    }
    const carried = takeMisses();
    const tail = carried === null ? {} : { shimMisses: carried };
    let text: string;
    try {
      text = JSON.stringify({ ...native, ...tail });
      if (utf8Length(text) > INPUT_CAP) {
        // Long strings (a big tool output) are cut with a marker first, so the event and what it
        // returned still reach Jevris; only if that is not enough is it reduced to its identity.
        const fitted = fitWithin({ ...native, ...tail }, INPUT_CAP);
        text = fitted ?? JSON.stringify({ hookKey, input: hookKey === 'event' ? input : { sessionID: sessionOf(input) }, delivery, ...link, ...extra, ...tail });
      }
    } catch {
      restoreMisses(carried);
      return null;
    }
    const startedAt = Date.now();
    let missed = false;
    const miss: ShimMissSink = (reasonCode, elapsedMs) => {
      if (missed) return;
      missed = true;
      noteMiss(reasonCode, elapsedMs);
      // The launcher never ran, so the misses this delivery carried were not recorded.
      if (reasonCode === 'SHIM_SPAWN_FAILED') restoreMisses(carried);
    };
    inFlight += 1;
    let call: Promise<string>;
    try {
      call = options.forward(text, wait, miss);
    } catch {
      inFlight -= 1;
      miss('SHIM_SPAWN_FAILED', Date.now() - startedAt);
      return null;
    }
    const limitMs = awaited ? messageTimeoutMs : wait ? timeoutMs : 30_000;
    const settled = withTimeout(call, limitMs, () => miss('SHIM_TIMEOUT', limitMs));
    void settled.then(() => {
      inFlight -= 1;
    });
    return settled;
  };
  const fireAndForget = (hookKey: string): PluginHook => async (input, output) => {
    try {
      const pending = send(hookKey, input, output);
      if (pending !== null) void pending.catch(() => '');
    } catch {
      // Observation never interrupts the harness.
    }
  };
  const observe = fireAndForget('event');
  const fireTool = fireAndForget('tool.execute.before');
  // A session the shim saw start: a task call there may be routed.
  const known = (session: string | null): session is string => session !== null && (tops.has(session) || parents.has(session));
  const taskCall = (input: unknown, output: unknown): { readonly session: string; readonly callId: string | null; readonly subagentType: string | null } | null => {
    if (!isPlainObject(input) || own(input, 'tool') !== 'task' || !isPlainObject(output)) return null;
    const args = own(output, 'args');
    if (!isPlainObject(args) || TASK_PIN_KEYS.some((key) => Object.hasOwn(args, key))) return null;
    const session = sessionOf(input);
    return known(session) ? { session, callId: field(own(input, 'callID')), subagentType: agentTypeField(own(args, 'subagent_type')) } : null;
  };
  // A task call's route waits for the child it starts; two calls in flight are ambiguous.
  const hold = (parent: string, callId: string | null, route: PluginRoute | null, subagentType: string | null): void => {
    const current = held.get(parent);
    const calls = new Set(current?.calls ?? []);
    calls.add(callId ?? `call-${calls.size}`);
    remember(held, parent, { route: current === undefined ? route : null, subagentType, calls });
  };
  const release = (parent: string | null, callId: string | null): void => {
    const current = parent === null ? undefined : held.get(parent);
    if (parent === null || current === undefined || callId === null || !current.calls.has(callId)) return;
    const calls = new Set(current.calls);
    calls.delete(callId);
    if (calls.size === 0) held.delete(parent);
    else remember(held, parent, { route: null, subagentType: current.subagentType, calls });
  };
  const sessionStarted = (bus: unknown): void => {
    if (!isPlainObject(bus) || own(bus, 'type') !== 'session.created') return;
    const props = own(bus, 'properties');
    const info = isPlainObject(props) ? own(props, 'info') : null;
    if (!isPlainObject(info)) return;
    const id = field(own(info, 'id'));
    const parent = field(own(info, 'parentID'));
    if (id === null) return;
    if (parent === null) {
      if (!tops.has(id)) remember(tops, id, { lastInput: null, changed: false });
      return;
    }
    const waiting = held.get(parent);
    if (waiting === undefined) return;
    held.delete(parent);
    const titled = subagentTypeOfTitle(own(info, 'title'));
    if (waiting.route === null || waiting.calls.size !== 1 || (titled !== null && waiting.subagentType !== null && titled !== waiting.subagentType)) return;
    remember(childRoutes, id, { route: waiting.route, subagentType: waiting.subagentType });
  };
  // A top-level turn: whether it may ask route.turn, and the person's own model changes.
  const turnAllowed = (session: string, output: unknown): boolean => {
    const record = tops.get(session);
    if (record === undefined) return false;
    const key = turnModelKey(output) ?? '';
    const seen = record.lastInput !== null;
    const changed = record.changed || (seen && record.lastInput !== key);
    remember(tops, session, { lastInput: key, changed });
    return seen && key !== '' && !changed;
  };
  // The model the turn runs on: the route written, else the model the harness resolved (R53).
  const noteTurn = (session: string, resolved: ReturnType<typeof resolvedTurnModel>, applied: PluginRoute | null): void => {
    if (applied !== null) remember(turnModel, session, { providerID: applied.providerID, modelID: applied.modelID });
    else if (resolved !== null) remember(turnModel, session, { providerID: resolved.providerID, modelID: resolved.modelID });
    else turnModel.delete(session);
  };
  // The held route on a child's first message, if the child runs on its parent's model.
  const routeChild = async (child: string, input: unknown, output: unknown): Promise<void> => {
    const bound = childRoutes.get(child);
    if (bound === undefined) return;
    childRoutes.delete(child);
    const parent = parents.get(child);
    const parentModel = parent === undefined ? undefined : turnModel.get(parent);
    const model = resolvedTurnModel(output);
    if (parentModel === undefined || model === null || model.providerID !== parentModel.providerID || model.modelID !== parentModel.modelID) return;
    if (bound.subagentType !== null && isPlainObject(input) && field(own(input, 'agent'), 64) !== bound.subagentType) return;
    if (await allowed(bound.route.providerID)) applyMessageModel(output, bound.route);
  };
  return {
    event: async (input) => {
      try {
        // A turn's text ends with the turn.
        const bus = isPlainObject(input) ? own(input, 'event') : null;
        const type = isPlainObject(bus) ? own(bus, 'type') : null;
        if (type === 'session.idle' || type === 'session.deleted') {
          const session = sessionOf(isPlainObject(bus) ? own(bus, 'properties') : null);
          if (session !== null && type === 'session.idle') shown.delete(session);
          if (session !== null && type === 'session.deleted') forget(session);
        }
        sessionStarted(bus);
      } catch {
        // Observation never interrupts the harness.
      }
      await observe(input);
    },
    'tool.execute.before': async (input, output) => {
      let task: ReturnType<typeof taskCall> = null;
      try {
        task = taskCall(input, output);
      } catch {
        task = null;
      }
      if (task === null) {
        await fireTool(input, output);
        return;
      }
      try {
        const pending = send('tool.execute.before', input, output, true);
        if (pending === null) return;
        if (options.harness === 'kilocode' || options.harness === 'opencode') hold(task.session, task.callId, routeResponseOf(await pending), task.subagentType);
      } catch {
        // The task runs as the harness chose.
      }
    },
    'tool.execute.after': async (input, output) => {
      try {
        if (isPlainObject(input) && own(input, 'tool') === 'task') release(sessionOf(input), field(own(input, 'callID')));
      } catch {
        // Observation never interrupts the harness.
      }
      await fireAndForget('tool.execute.after')(input, output);
    },
    'chat.message': async (input, output) => {
      try {
        const session = isPlainObject(input) ? sessionOf(input) : null;
        if (session === null || parents.has(session)) {
          // A subagent's message shows nothing: it is observed, and it may take the route its task
          // call was given.
          const pending = send('chat.message', input, output);
          if (pending !== null) void pending.catch(() => '');
          if (session !== null) await routeChild(session, input, output);
          return;
        }
        shown.delete(session);
        // Read before any route is written: the model the harness resolved for this turn (R53).
        const resolved = resolvedTurnModel(output);
        const ask = turnAllowed(session, output);
        const pending = send('chat.message', input, output, true, ask ? { routeTurn: true } : {});
        if (pending === null) {
          noteTurn(session, resolved, null);
          return;
        }
        const response = await pending;
        keepShown(session, systemLinesOf(response));
        let applied: PluginRoute | null = null;
        if (ask) {
          const route = turnResponseOf(options.harness, response, { sessionId: session, messageId: turnMessageId(input, output) });
          if (route !== null && (await allowed(route.providerID)) && applyMessageModel(output, route)) applied = route;
        }
        noteTurn(session, resolved, applied);
      } catch {
        // The message proceeds without Jevris text and on its own model.
      }
    },
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const session = isPlainObject(input) ? sessionOf(input) : null;
        const lines = session === null ? undefined : shown.get(session);
        if (lines === undefined || !isPlainObject(output)) return;
        const system = own(output, 'system');
        if (!Array.isArray(system)) return;
        for (const line of lines) if (!system.includes(line)) system.push(line);
      } catch {
        // The model call proceeds without Jevris text.
      }
    },
    'command.execute.before': fireAndForget('command.execute.before'),
    'experimental.session.compacting': async (input, output) => {
      try {
        const pending = send('experimental.session.compacting', input, output);
        if (pending === null) return;
        applyPluginResponse(output, await pending);
      } catch {
        // Compaction proceeds without Jevris context.
      }
    },
  };
}

interface ChildLike {
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
  readonly stdin: { on(event: 'error', listener: () => void): void; end(data: string): void } | null;
  on(event: 'error' | 'close', listener: () => void): void;
  kill(): void;
  unref?(): void;
}

/**
 * The default forwarder: runs `node <launcher> --harness <name>` with the native event on
 * stdin (never argv), no shell, a hard timeout, and stdout capped. A missing node or
 * launcher resolves to ''.
 */
export function spawnForwarder(nodePath: string, launcherPath: string, launcherName: string): PluginForward {
  return async (nativeJson, awaitResponse, onMiss) => {
    const startedAt = Date.now();
    let childProcess: { spawn(command: string, args: readonly string[], options: object): ChildLike };
    try {
      childProcess = (await import('node:child_process' as string)) as typeof childProcess;
    } catch {
      onMiss?.('SHIM_SPAWN_FAILED', Date.now() - startedAt);
      return '';
    }
    return new Promise<string>((resolve) => {
      let out = '';
      let finished = false;
      const finish = (value: string): void => {
        if (finished) return;
        finished = true;
        resolve(value);
      };
      const fail = (reasonCode: ShimMissCode): void => {
        if (finished) return;
        onMiss?.(reasonCode, Date.now() - startedAt);
        finish('');
      };
      let child: ChildLike;
      try {
        child = childProcess.spawn(nodePath, [launcherPath, '--harness', launcherName], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', awaitResponse ? 'pipe' : 'ignore', 'ignore'],
        });
      } catch {
        fail('SHIM_SPAWN_FAILED');
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        fail('SHIM_KILLED');
      }, awaitResponse ? 5000 : 30_000);
      child.on('error', () => {
        clearTimeout(timer);
        fail('SHIM_SPAWN_FAILED');
      });
      child.on('close', () => {
        clearTimeout(timer);
        finish(out);
      });
      child.stdout?.on('data', (chunk) => {
        if (out.length < 65_536) out += String(chunk);
      });
      child.stdin?.on('error', () => {});
      try {
        child.stdin?.end(nativeJson);
      } catch {
        fail('SHIM_SPAWN_FAILED');
      }
    });
  };
}
