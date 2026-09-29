/**
 * Found-gone signals from the owned-worker streams (C's model-availability table, owner decision
 * 9d1e7eb: a model found gone on this machine is never routed, explored or launched).
 *
 * Each harness port reads its own stream for one signal id from C's MODEL_UNAVAILABLE_SIGNALS,
 * and C's `classifyModelUnavailable` says what it means. A port never maps a signal to a reason
 * itself. The rules come from C's table:
 *
 * - A structured signal counts on its own: OpenCode and Kilo's `ProviderModelNotFoundError`.
 *   Until a capture confirms where it arrives (coordinator, 2026-09-27), it is accepted both as
 *   the stream's error event and as the error name or "Model not found: <provider/model>" on
 *   stderr, and certify marks it unverified.
 * - A text-matched signal (Claude Code's "issue with the selected model", Codex's
 *   model_not_found and the ChatGPT-account refusal) counts only from a binary whose capture
 *   (`jevris certify --model-signals`, model-signal-capture.ts) saw that exact signal at that
 *   exact version. Until then it is detected and reported, but never recorded.
 * - Antigravity's `unknown-model` is text-matched like the Claude Code and Codex signals: it counts,
 *   as MODEL_NOT_ACCESSIBLE, only from a binary whose capture saw it (harness parity audit G12).
 *
 * What a signal keeps is its id, its channel and the key names of the event that carried it;
 * never the harness's message text, which can name an account.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyModelUnavailable, type AvailabilityAuthMode, type ModelSignalPort, type ModelUnavailableReason } from '@jevris/core';
import { certificationsDir } from './certification-store.js';
import type { GlobalHarness } from './global-harness.js';

export const MODEL_SIGNALS_SCHEMA = 'jevris-model-signals-1' as const;

/** One signal a stream showed: C's signal id, where it came from, and the carrying event's key names. */
export interface ModelSignal {
  readonly id: string;
  /** `event`: a JSON event on stdout. `stderr`: the harness's error output (OpenCode/Kilo only). */
  readonly channel: 'event' | 'stderr';
  /** Dotted key names of the carrying event (never values); empty for stderr. */
  readonly shape: readonly string[];
}

/** What a port reports with status `model-unavailable` (D records it with C's recordModelUnavailable). */
export interface ModelUnavailable {
  readonly reasonCode: ModelUnavailableReason;
  readonly port: ModelSignalPort;
  readonly authMode: AvailabilityAuthMode;
}

const MAX_SHAPE_KEYS = 40;
const KEY = /^[A-Za-z0-9_$-]{1,64}$/;

/** The dotted key names of an event, three levels deep, sorted; a key that is not a plain name is left out. */
export function eventShape(event: unknown, depth = 3): readonly string[] {
  const out: string[] = [];
  const walk = (value: unknown, prefix: string, level: number): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || level > depth) return;
    for (const key of Object.keys(value as object)) {
      if (!KEY.test(key)) continue;
      const path = prefix === '' ? key : `${prefix}.${key}`;
      out.push(path);
      walk((value as { readonly [k: string]: unknown })[key], path, level + 1);
    }
  };
  walk(event, '', 1);
  return out.sort().slice(0, MAX_SHAPE_KEYS);
}

/** Claude Code: a result with is_error whose text is its "issue with the selected model" message. */
export function claudeModelSignal(isError: boolean, text: string | null): string | null {
  if (!isError || text === null) return null;
  return /issue with the selected model/i.test(text) && /may not exist|not have access/i.test(text) ? 'selected-model-issue' : null;
}

/** Codex: a turn.failed (or error) message that is OpenAI's model_not_found or the ChatGPT-account refusal. */
export function codexModelSignal(message: string): string | null {
  if (/\bmodel_not_found\b|does not exist or you do not have access/i.test(message)) return 'model-not-found';
  if (/not supported when using codex with a chatgpt account|model is not supported[^\n]{0,80}chatgpt account/i.test(message)) return 'model-not-supported-for-account';
  return null;
}

/** OpenCode and Kilo: an error event whose error is named ProviderModelNotFoundError. */
export function opencodeEventModelSignal(error: unknown): string | null {
  const name = error !== null && typeof error === 'object' ? (error as { readonly name?: unknown }).name : undefined;
  return name === 'ProviderModelNotFoundError' ? 'provider-model-not-found' : null;
}

/** OpenCode and Kilo on stderr: the error's name, or "Model not found: <provider/model>" for the model asked for. */
export function opencodeStderrModelSignal(stderr: string, harnessModel: string): string | null {
  if (/\bProviderModelNotFoundError\b/.test(stderr)) return 'provider-model-not-found';
  return harnessModel !== '' && stderr.toLowerCase().includes(`model not found: ${harnessModel.toLowerCase()}`) ? 'provider-model-not-found' : null;
}

/** Antigravity: an ERROR result naming an unknown model (C's row has no reason until a capture). */
export function antigravityModelSignal(text: string): string | null {
  return /\b(?:unknown|invalid|unsupported) model\b|\bmodel\b[^\n]{0,80}\bnot (?:found|supported|available)\b/i.test(text) ? 'unknown-model' : null;
}

function availabilityAuth(authMode: string): AvailabilityAuthMode {
  return authMode === 'api-key' || authMode === 'subscription' ? authMode : 'unknown';
}

/**
 * C's classification of a signal a port saw, or null. A text-matched signal counts only when
 * `certifiedSignals` (the capture for this binary version) holds its id.
 */
export function modelUnavailableOf(port: ModelSignalPort, signal: ModelSignal | null, certifiedSignals: readonly string[] | undefined, authMode: string): ModelUnavailable | null {
  if (signal === null) return null;
  const reasonCode = classifyModelUnavailable({ port, signal: signal.id, certified: certifiedSignals?.includes(signal.id) === true });
  return reasonCode === null ? null : { reasonCode, port, authMode: availabilityAuth(authMode) };
}

/** The outcome reason for `model-unavailable`: the model, C's reason and the port; never the harness's text. */
export function modelUnavailableText(model: string, unavailable: ModelUnavailable): string {
  return `model ${model.slice(0, 128)} is not available here (${unavailable.reasonCode} via ${unavailable.port})`;
}

/** One harness's capture record (model-signal-capture.ts): what a nonexistent model id produced. */
export interface ModelSignalCapture {
  readonly schema: typeof MODEL_SIGNALS_SCHEMA;
  readonly harness: GlobalHarness;
  /** The harness version the capture ran on; null when `--version` printed none. */
  readonly version: string | null;
  readonly capturedAt: string;
  readonly probeModel: string;
  /** The port's status for the probe run. */
  readonly status: string;
  /** The signal the stream showed, or null when none of the known ones did. */
  readonly signal: ModelSignal | null;
}

/** Where a harness's capture is kept: a folder inside certifications/ (its records loader reads only top-level files). */
export function modelSignalsFile(home: string, harness: GlobalHarness): string {
  return join(certificationsDir(home), 'model-signals', `${harness}.json`);
}

/** A harness's capture record, or null when none is readable. */
export async function loadModelSignalCapture(home: string, harness: GlobalHarness): Promise<ModelSignalCapture | null> {
  try {
    const parsed = JSON.parse(await readFile(modelSignalsFile(home, harness), 'utf8')) as { readonly [key: string]: unknown };
    if (parsed['schema'] !== MODEL_SIGNALS_SCHEMA || parsed['harness'] !== harness) return null;
    const signal = parsed['signal'] as { readonly [key: string]: unknown } | null;
    const validSignal = signal === null || (typeof signal === 'object' && typeof signal['id'] === 'string' && (signal['channel'] === 'event' || signal['channel'] === 'stderr') && Array.isArray(signal['shape']));
    if (!validSignal || typeof parsed['capturedAt'] !== 'string' || typeof parsed['probeModel'] !== 'string' || typeof parsed['status'] !== 'string') return null;
    if (parsed['version'] !== null && typeof parsed['version'] !== 'string') return null;
    return parsed as unknown as ModelSignalCapture;
  } catch {
    return null;
  }
}

/** The signal ids a capture certified for this exact harness version (none without a matching capture). */
export async function certifiedModelSignals(home: string, harness: GlobalHarness, version: string | null): Promise<readonly string[]> {
  if (version === null) return [];
  const capture = await loadModelSignalCapture(home, harness);
  return capture !== null && capture.version === version && capture.signal !== null ? [capture.signal.id] : [];
}

/**
 * Wraps a port's run so a run on the harness's own binary gets the signals certified for the
 * probed version. A caller's own `certifiedModelSignals` (a test) is kept as it is.
 */
export function withCertifiedSignals<I extends { readonly certifiedModelSignals?: readonly string[] }, O>(
  harness: GlobalHarness,
  run: (input: I) => Promise<O>,
  evidence: { readonly home: string; readonly version: () => Promise<string | null> } | null,
): (input: I) => Promise<O> {
  if (evidence === null) return run;
  return async (input) => {
    if (input.certifiedModelSignals !== undefined) return run(input);
    let certified: readonly string[] = [];
    try {
      certified = await certifiedModelSignals(evidence.home, harness, await evidence.version());
    } catch {
      certified = [];
    }
    return run({ ...input, certifiedModelSignals: certified });
  };
}
