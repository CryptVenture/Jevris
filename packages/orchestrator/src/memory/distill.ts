/**
 * Tool-output distillation (MEM-08; SSOT §9.4, C22, US15, E23).
 *
 * Raw output is stored content-addressed under retention (`ev:<sha256>`), and
 * `jevris evidence get <handle>` returns the original bytes. The model-visible view is built
 * by deterministic filters that always keep the exit code, stderr (bounded), failing
 * assertions and their context, a truncation marker and the handle. Unknown, binary or
 * sensitive output passes through unchanged: Jevris never rewrites what it cannot read safely.
 * A Jev Score (C22) may pick which extra spans to keep, within the same budget, and never drops
 * the failure lines.
 *
 * Output is replaced in the harness only where the harness supports replacement and the
 * adapter is certified for it; otherwise the view is advisory (offered as a handle).
 */
import type { WorkspaceServices } from '../workspace.js';
import { consultScoreBatch } from '../capabilities/consult.js';
import { SECRET_PATTERNS } from '@jevris/contracts';
import { estimateTokens, recordKey, safeText, sha256 } from '../util.js';

export interface DistillInput {
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly stdout: string | Uint8Array;
  readonly stderr?: string | Uint8Array;
  /** Declared media type from the harness, when it gives one. */
  readonly mediaType?: string | null;
  /** Token budget for the view. */
  readonly budgetTokens?: number;
  readonly engine?: unknown;
  readonly egressApproved?: boolean;
  readonly remainingMs?: number;
  readonly nowMs?: number;
}

export type DistillMode = 'distilled' | 'passthrough';

export interface DistillResult {
  readonly handle: string;
  readonly mode: DistillMode;
  /** Why the output passed through unchanged, when it did. */
  readonly passthroughReason: 'binary' | 'sensitive' | 'unknown-type' | 'small' | null;
  readonly text: string;
  readonly rawBytes: number;
  readonly viewTokens: number;
  readonly keptLines: number;
  readonly omittedLines: number;
  readonly exitCode: number | null;
  readonly source: 'rules' | 'jev';
}

const FAILURE = /(^|\b)(error|failed|failure|fail:|not ok|assert(ion)?|expected|received|actual|panic|exception|traceback|✖|✗|FAIL\b|ERR!|fatal|undefined reference|cannot find|segmentation fault)/i;
const STACK = /^\s+(at |File "|in |#\d+ )/;
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-ndjson))/;

function toBytes(v: string | Uint8Array | undefined): Uint8Array {
  if (v === undefined) return new Uint8Array(0);
  return typeof v === 'string' ? new TextEncoder().encode(v) : v;
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i += 1) if (bytes[i] === 0) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n));
    return false;
  } catch {
    // A multi-byte sequence cut at the sample edge is not binary.
    return n === bytes.length;
  }
}

export function looksSensitive(text: string): boolean {
  return SECRET_PATTERNS.some((p) => new RegExp(p, 'u').test(text));
}

interface Line {
  readonly index: number;
  readonly text: string;
}

/** Indexes of lines to keep: failures with 2 lines of context, stack frames after them, head and tail. */
function mandatoryLines(lines: readonly string[]): Set<number> {
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!FAILURE.test(lines[i] as string)) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j += 1) keep.add(j);
    for (let j = i + 1; j < Math.min(lines.length, i + 12) && STACK.test(lines[j] as string); j += 1) keep.add(j);
  }
  for (let i = 0; i < Math.min(3, lines.length); i += 1) keep.add(i);
  for (let i = Math.max(0, lines.length - 5); i < lines.length; i += 1) keep.add(i);
  return keep;
}

/** A kept span of the stored original: byte offsets `[startByte, endByte)`, lines `[startLine, endLine)` (0-based). */
export interface KeptSpan {
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * What Jevris knows about one stored tool or check output beyond its bytes (US15): the error
 * state, where stderr starts, and which spans of the original a distilled view kept. The
 * original stays behind its handle, unchanged; this record never replaces it.
 */
export interface OutputRecord {
  readonly handle: string;
  readonly exitCode: number | null;
  /** `failed` for a non-zero exit, `succeeded` for zero, `unknown` when no exit code is known. */
  readonly errorState: 'failed' | 'succeeded' | 'unknown';
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** Byte offset of stderr in the stored original, or null when there is none. */
  readonly stderrOffset: number | null;
  readonly mode: DistillMode;
  readonly passthroughReason: DistillResult['passthroughReason'];
  /** Spans of stdout the view kept, in the stored original's coordinates (at most 256). */
  readonly keptSpans: readonly KeptSpan[];
  readonly keptLines: number;
  readonly omittedLines: number;
  /** The model-visible view (at most 16 KiB; empty for binary or sensitive output). */
  readonly viewText: string;
  readonly createdAtMs: number;
}

const OUTPUT_RECORDS = 'output-records';
const MAX_SPANS = 256;

function errorStateOf(exitCode: number | null): OutputRecord['errorState'] {
  if (exitCode === null) return 'unknown';
  return exitCode === 0 ? 'succeeded' : 'failed';
}

/** The output record for a handle in this workspace, when one was written. */
export function outputRecordOf(ws: WorkspaceServices, handle: string): OutputRecord | undefined {
  return ws.state.get<OutputRecord>(OUTPUT_RECORDS, recordKey(ws.workspaceId, sha256(handle).slice(0, 32)));
}

/** Byte offset at which each line starts, splitting as `split(/\r?\n/)` does, plus the end. */
function lineOffsets(text: string): { readonly lines: readonly string[]; readonly starts: readonly number[]; readonly ends: readonly number[] } {
  const enc = new TextEncoder();
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  let pos = 0;
  for (const line of lines) {
    starts.push(at);
    const len = enc.encode(line).length;
    ends.push(at + len);
    pos += line.length;
    const crlf = text.startsWith('\r\n', pos);
    const nl = crlf ? 2 : text.startsWith('\n', pos) ? 1 : 0;
    pos += nl;
    at += len + nl;
  }
  return { lines, starts, ends };
}

export interface ViewInput extends Omit<DistillInput, 'stdout' | 'stderr'> {
  readonly handle: string;
  readonly out: Uint8Array;
  readonly err: Uint8Array;
  readonly rawBytes: number;
  /** Offset of stdout and stderr in the stored original. */
  readonly stdoutOffset: number;
  readonly stderrOffset: number | null;
}

/** A view built from rules alone, with the blocks the rules could not place yet. */
type PreparedView =
  | { readonly done: BuiltView }
  | {
      readonly lines: readonly string[];
      readonly starts: readonly number[];
      readonly ends: readonly number[];
      readonly keep: Set<number>;
      readonly header: string;
      readonly stderrView: string;
      readonly used: number;
      readonly budget: number;
      readonly blocks: readonly { readonly start: number; readonly end: number; readonly text: string }[];
    };

/** A built view: the result and the spans of the stored original it kept. */
export interface BuiltView {
  readonly result: DistillResult;
  readonly spans: readonly KeptSpan[];
}

/** The rules part of a view (pure: no store, no Jev), so it can run in a worker thread (P6). */
function prepareView(input: ViewInput): PreparedView {
  const { out, err } = input;
  const base = { handle: input.handle, rawBytes: input.rawBytes, exitCode: input.exitCode, source: 'rules' as const };
  const pass = (reason: NonNullable<DistillResult['passthroughReason']>, text: string, spans: readonly KeptSpan[] = []): PreparedView => ({
    done: {
      result: {
        ...base,
        mode: 'passthrough' as const,
        passthroughReason: reason,
        text,
        viewTokens: estimateTokens(text),
        keptLines: text.split('\n').length,
        omittedLines: 0,
      },
      spans,
    },
  });
  if (input.mediaType !== undefined && input.mediaType !== null && !TEXT_TYPES.test(input.mediaType)) return pass('unknown-type', '');
  if (isBinary(out) || isBinary(err)) return pass('binary', '');
  const stdout = new TextDecoder().decode(out);
  const stderr = new TextDecoder().decode(err);
  // Sensitive output is never rewritten (a partial view could hide or reshape a secret).
  if (looksSensitive(stdout) || looksSensitive(stderr)) return pass('sensitive', '');
  const budget = Math.max(200, Math.min(input.budgetTokens ?? 2_000, 50_000));
  const { lines, starts, ends } = lineOffsets(stdout);
  if (estimateTokens(stdout) + estimateTokens(stderr) <= budget) {
    const whole = out.length === 0 ? [] : [{ startByte: input.stdoutOffset, endByte: input.stdoutOffset + out.length, startLine: 0, endLine: lines.length }];
    return pass('small', `${stdout}${stderr.length > 0 ? `\n${stderr}` : ''}`, whole);
  }

  const keep = mandatoryLines(lines);
  const header = `exit code: ${input.exitCode === null ? 'unknown' : String(input.exitCode)}${input.command === null ? '' : `\ncommand: ${safeText(input.command, 200)}`}`;
  const stderrView = stderr.length === 0 ? '' : `\nstderr (${String(err.length)} bytes):\n${stderr.length > 4_000 ? `${stderr.slice(0, 2_000)}\n[... stderr truncated ...]\n${stderr.slice(-1_500)}` : stderr}`;
  let used = estimateTokens(header) + estimateTokens(stderrView) + 60;
  for (const i of keep) used += estimateTokens(lines[i] as string) + 1;
  // Optional spans: blocks of 20 lines not already kept, ranked by rules or Jev (C22).
  const blocks: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  for (let s = 0; s < lines.length; s += 20) {
    const e = Math.min(lines.length, s + 20);
    let covered = true;
    for (let k = s; k < e && covered; k += 1) covered = keep.has(k);
    if (covered) continue;
    blocks.push({ start: s, end: e, text: lines.slice(s, e).join('\n') });
  }
  return { lines, starts, ends, keep, header, stderrView, used, budget, blocks };
}

/** The view from the prepared rules part and the optional spans' scores (pure). */
function assembleView(input: ViewInput, prepared: Exclude<PreparedView, { readonly done: BuiltView }>, scores: ReadonlyMap<number, number>, source: 'rules' | 'jev'): BuiltView {
  const { lines, starts, ends, keep, header, stderrView, budget, blocks } = prepared;
  let used = prepared.used;
  const ranked = [...blocks].sort((a, b) => (scores.get(b.start) ?? 0) - (scores.get(a.start) ?? 0) || b.start - a.start);
  for (const b of ranked) {
    const cost = estimateTokens(b.text) + 20;
    if (used + cost > budget) continue;
    for (let i = b.start; i < b.end; i += 1) keep.add(i);
    used += cost;
  }
  const kept: Line[] = [...keep].sort((a, b) => a - b).map((i) => ({ index: i, text: lines[i] as string }));
  let body = '';
  let prev = -1;
  const spans: KeptSpan[] = [];
  for (const l of kept) {
    if (l.index > prev + 1) body += `[... ${String(l.index - prev - 1)} lines omitted ...]\n`;
    body += `${l.text}\n`;
    const last = spans[spans.length - 1];
    const startByte = input.stdoutOffset + (starts[l.index] as number);
    const endByte = input.stdoutOffset + (ends[l.index] as number);
    if (last !== undefined && last.endLine === l.index) spans[spans.length - 1] = { ...last, endByte, endLine: l.index + 1 };
    else spans.push({ startByte, endByte, startLine: l.index, endLine: l.index + 1 });
    prev = l.index;
  }
  if (prev < lines.length - 1) body += `[... ${String(lines.length - 1 - prev)} lines omitted ...]\n`;
  const omitted = lines.length - kept.length;
  const text = `${header}\n${body}${stderrView}\n[output truncated: ${String(omitted)} of ${String(lines.length)} lines omitted; full output: jevris evidence get ${input.handle}]`;
  return {
    result: {
      handle: input.handle,
      rawBytes: input.rawBytes,
      exitCode: input.exitCode,
      source,
      mode: 'distilled',
      passthroughReason: null,
      text,
      viewTokens: estimateTokens(text),
      keptLines: kept.length,
      omittedLines: omitted,
    },
    spans,
  };
}

/**
 * The view by rules alone (no Jev span ranking), pure and synchronous: what a check's stored
 * output gets, built in a worker thread when the output is large (sidecar concurrency audit P6).
 */
export function rulesView(input: ViewInput): BuiltView {
  const prepared = prepareView(input);
  return 'done' in prepared ? prepared.done : assembleView(input, prepared, new Map(), 'rules');
}

async function buildView(ws: WorkspaceServices, input: ViewInput): Promise<BuiltView> {
  const prepared = prepareView(input);
  if ('done' in prepared) return prepared.done;
  let source: 'rules' | 'jev' = 'rules';
  const scores = new Map<number, number>();
  if (input.engine !== undefined && input.egressApproved === true && (input.remainingMs === undefined || input.remainingMs > 1_500)) {
    // The spans are scored together (at most 8, so one request of up to 8 questions): the wait is one request, not eight, and each
    // span keeps its own answer, its own confidence floor and its own rules fallback. A span is workspace text, so it is sent only
    // with the administrator's approval as well (`sendsWorkspaceText`): the person's preference alone sends nothing.
    const asked = prepared.blocks.slice(0, 8);
    const results = await consultScoreBatch(input.engine, {
      capabilityId: 'C22',
      specVersion: '1',
      sendsWorkspaceText: true,
      objective: 'Keep the output spans that help diagnose the result.',
      instructions: 'How useful is this span of tool output for diagnosing the command result?',
      anchors: ['Noise: nothing in this span helps with the task.', 'Background: context that rarely matters.', 'Useful: it helps with part of the task.', 'Essential: the task cannot be done without it.'],
      noun: 'span',
      items: asked.map((b) => ({ evidence: { id: `span-${String(b.start)}`, text: b.text, sourceKind: 'tool' as const, priority: 'optional' as const }, rules: () => ({ score: 0, reasonCode: 'RULES' }) })),
      workspaceId: ws.workspaceId,
      evidenceRevision: input.handle.slice(3, 40),
      ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
    });
    asked.forEach((b, i) => {
      const r = results[i];
      if (r === undefined) return;
      if (r.source === 'jev') source = 'jev';
      scores.set(b.start, r.value);
    });
  }
  return assembleView(input, prepared, scores, source);
}

/** Records a built view's error state and kept spans against its handle (the original is unchanged). */
export async function recordOutput(ws: WorkspaceServices, input: ViewInput, view: BuiltView): Promise<void> {
  const record: OutputRecord = {
    handle: input.handle,
    exitCode: input.exitCode,
    errorState: errorStateOf(input.exitCode),
    stdoutBytes: input.out.length,
    stderrBytes: input.err.length,
    stderrOffset: input.err.length > 0 ? input.stderrOffset : null,
    mode: view.result.mode,
    passthroughReason: view.result.passthroughReason,
    keptSpans: view.spans.slice(0, MAX_SPANS),
    keptLines: view.result.keptLines,
    omittedLines: view.result.omittedLines,
    viewText: view.result.text.slice(0, 16_384),
    createdAtMs: input.nowMs ?? Date.now(),
  };
  await ws.state.transact((tx) => tx.put(OUTPUT_RECORDS, recordKey(ws.workspaceId, sha256(input.handle).slice(0, 32)), record));
}

export async function distillOutput(ws: WorkspaceServices, input: DistillInput): Promise<DistillResult> {
  const out = toBytes(input.stdout);
  const err = toBytes(input.stderr);
  const raw = new Uint8Array(out.length + err.length + (err.length > 0 ? 1 : 0));
  raw.set(out, 0);
  if (err.length > 0) {
    raw.set([10], out.length);
    raw.set(err, out.length + 1);
  }
  const meta = await ws.evidence.put({ workspaceId: ws.workspaceId, kind: 'tool-output', bytes: raw, ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }) });
  const view: ViewInput = { ...input, handle: meta.handle, out, err, rawBytes: raw.length, stdoutOffset: 0, stderrOffset: err.length > 0 ? out.length + 1 : null };
  const built = await buildView(ws, view);
  await recordOutput(ws, view, built);
  return built.result;
}

export interface StoredOutputInput extends Omit<DistillInput, 'stdout' | 'stderr'> {
  /** Handle of an output already in the evidence store (the verify runner's `runner-output`). */
  readonly handle: string;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  /** Byte offset of stderr in the stored original. */
  readonly stderrOffset: number;
}

/**
 * Log reduction for an output that is already stored (MEM-08, US15): builds the same view as
 * `distillOutput` and records its error state and kept spans against the existing handle,
 * without storing the bytes again. The original is never modified.
 */
export async function distillStoredOutput(ws: WorkspaceServices, input: StoredOutputInput): Promise<DistillResult | undefined> {
  const meta = ws.evidence.metaIn(input.handle, ws.workspaceId);
  if (meta === undefined) return undefined;
  const view: ViewInput = { ...input, out: input.stdout, err: input.stderr, rawBytes: meta.bytes, stdoutOffset: 0, stderrOffset: input.stderr.length > 0 ? input.stderrOffset : null };
  const built = await buildView(ws, view);
  await recordOutput(ws, view, built);
  return built.result;
}

/**
 * Records a view already built for a stored output (the verify runner's, P6) against its handle,
 * as `distillStoredOutput` would have. Undefined when the handle is not this workspace's.
 */
export async function recordStoredView(ws: WorkspaceServices, input: StoredOutputInput, built: BuiltView): Promise<DistillResult | undefined> {
  const meta = ws.evidence.metaIn(input.handle, ws.workspaceId);
  if (meta === undefined || built.result.handle !== input.handle) return undefined;
  const view: ViewInput = { ...input, out: input.stdout, err: input.stderr, rawBytes: meta.bytes, stdoutOffset: 0, stderrOffset: input.stderr.length > 0 ? input.stderrOffset : null };
  await recordOutput(ws, view, built);
  return built.result;
}

/**
 * Whether a view may replace the harness's tool output. Only when the harness supports output
 * replacement and the adapter is certified for it; everything else keeps the original output.
 */
export function mayReplaceOutput(supportsReplacement: boolean, certified: boolean): boolean {
  return supportsReplacement && certified;
}
