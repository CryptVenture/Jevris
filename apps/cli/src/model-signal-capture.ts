/**
 * `jevris certify --harness <name|all> --model-signals`: the found-gone capture (C's table, F's
 * certify step). For each harness it starts ONE owned turn on the user's own installed harness,
 * with the user's own sign-in, asking for a model id that does not exist, and records which
 * found-gone signal the stream showed at that binary version. A text-matched signal counts only
 * from a binary whose capture saw it (model-signals.ts).
 *
 * What each case launches is in MODEL_SIGNAL_CASES (the exact argv, from the ports' own builders)
 * and is printed before it runs and in every `jevris certify` result:
 *
 * - one headless turn, the prompt on stdin, in an empty temporary folder, with no tools granted,
 *   one turn and a 0.05 USD cap where the harness has one (Claude Code), else one step;
 * - the user's own harness configuration and sign-in (it cannot be a throwaway profile: a
 *   provider only answers "no such model" to a signed-in request);
 * - no Jevris install or uninstall, and no change to any harness file.
 *
 * A harness is expected to refuse an unknown model before any billed work, but that is not
 * guaranteed, so the capture never runs by itself: not in install, not in a plain certify, not
 * in a test run (refused unless JEVRIS_LIVE_HARNESS=1) and not from an agent session without
 * the owner's go-ahead. The record keeps the signal id, its channel and the event's key names;
 * never the harness's message text.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_EXIT_CODES } from '@jevris/contracts';
import { MODEL_UNAVAILABLE_SIGNALS } from '@jevris/core';
import { writePrivateFile } from '@jevris/platform';
import { defaultHarnessCli, LAUNCHER, type GlobalHarness, type HarnessCli } from './global-harness.js';
import { probeHarnessVersion } from './harness-versions.js';
import { antigravityArgs, runAntigravityWorker } from './antigravity-worker.js';
import { claudePrintArgs, runClaudeWorker } from './claude-worker.js';
import { codexExecArgs, runCodexWorker } from './codex-worker.js';
import { runKiloWorker } from './kilo-worker.js';
import { liveHarnessAllowed } from './live-harness.js';
import { loadModelSignalCapture, MODEL_SIGNALS_SCHEMA, modelSignalsFile, type ModelSignal, type ModelSignalCapture } from './model-signals.js';
import { opencodeRunArgs, runOpencodeWorker } from './opencode-worker.js';

export interface ModelSignalCase {
  readonly harness: GlobalHarness;
  /** A model id that does not exist. */
  readonly probeModel: string;
  /** What the case starts, in words, printed before it runs and in `jevris certify` output. */
  readonly launches: string;
}

export const PROBE_PROMPT = 'Reply with OK.';
export const PROBE_BUDGET_USD = 0.05;
export const PROBE_TIMEOUT_MS = 90_000;
const PROBE_FOLDER = '<empty temporary folder>';

/** The exact argv a case starts (the prompt goes on stdin), from the ports' own argv builders. */
export function probeArgv(harness: GlobalHarness, model: string): readonly string[] {
  if (harness === 'claude') return [LAUNCHER.claude, ...claudePrintArgs({ model, maxTurns: 1, maxBudgetUsd: PROBE_BUDGET_USD, allowedTools: [] })];
  if (harness === 'codex') return [LAUNCHER.codex, ...codexExecArgs(model, 'read-only')];
  if (harness === 'opencode' || harness === 'kilocode') return [LAUNCHER[harness], ...opencodeRunArgs(model, PROBE_FOLDER, null)];
  return [LAUNCHER.antigravity, ...antigravityArgs(model, PROBE_TIMEOUT_MS, null)];
}

function probeCase(harness: GlobalHarness, probeModel: string): ModelSignalCase {
  const argv = probeArgv(harness, probeModel).map((arg) => (arg === '' ? '""' : /\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
  const extra = harness === 'opencode' || harness === 'kilocode' ? ', with every tool denied and a 1-step agent' : '';
  return { harness, probeModel, launches: `${argv}; with your own sign-in and settings, in ${PROBE_FOLDER}${extra}, the prompt "${PROBE_PROMPT}" on stdin` };
}

export const MODEL_SIGNAL_CASES: Readonly<Record<GlobalHarness, ModelSignalCase>> = {
  claude: probeCase('claude', 'claude-nonexistent-0'),
  codex: probeCase('codex', 'gpt-nonexistent-0'),
  opencode: probeCase('opencode', 'openai/gpt-nonexistent-0'),
  kilocode: probeCase('kilocode', 'openai/gpt-nonexistent-0'),
  antigravity: probeCase('antigravity', 'gemini-nonexistent-0'),
};

/** What the probe run gave: the port's status and the signal it saw. */
export interface ProbeRun {
  readonly status: string;
  readonly modelSignal: ModelSignal | null;
}

export interface ProbeInput {
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
}

export type ProbeRunner = (input: ProbeInput) => Promise<ProbeRun>;

/** The harness's own worker run on its real binary (no evidence recorded: a probe is not a task run). */
function defaultRunner(harness: GlobalHarness): ProbeRunner {
  if (harness === 'claude') return runClaudeWorker;
  if (harness === 'codex') return runCodexWorker;
  if (harness === 'opencode') return runOpencodeWorker;
  if (harness === 'kilocode') return runKiloWorker;
  return runAntigravityWorker;
}

/** A run that ended on the harness's own answer; anything else (refused, missing, timed out) teaches nothing. */
const RECORDED_STATUSES = new Set(['failed', 'model-unavailable', 'completed']);

/** One line per row of C's table for this harness: whether its signal counts on this binary, and why. */
export function modelSignalRows(harness: GlobalHarness, capture: ModelSignalCapture | null, version: string | null): readonly string[] {
  const current = capture !== null && version !== null && capture.version === version ? capture : null;
  return MODEL_UNAVAILABLE_SIGNALS.filter((row) => row.port === harness).map((row) => {
    const seen = current?.signal?.id === row.signal ? current.signal : null;
    let state: string;
    if (seen !== null && row.reasonCode === null) state = `seen by the capture at ${version ?? ''} (${seen.channel}); C's table gives it no reason yet, so it is never recorded`;
    else if (seen !== null) state = `${row.reasonCode ?? ''}, confirmed by the capture at ${version ?? ''} (${seen.channel === 'event' ? 'stream event' : 'stderr'})`;
    else if (current !== null) state = `not seen by the capture at ${version ?? ''} (status ${current.status}); ${row.structured ? 'still counts as structured, but send C the capture' : 'stays unused'}`;
    else if (row.reasonCode === null) state = "no reason in C's table until a real stream is captured";
    else if (!row.needsCertifiedBinary) state = `${row.reasonCode}, structured; ${harness === 'opencode' || harness === 'kilocode' ? 'unverified: accepted as a stream error event and on stderr until a capture shows which' : 'counts on its own'}`;
    else state = `${row.reasonCode}, text-matched: unused until a capture at this version confirms it`;
    return `model signal ${row.signal}: ${state}`;
  });
}

export interface CaptureOptions {
  readonly home: string;
  readonly harness: GlobalHarness;
  readonly nowMs?: number;
  /** Default: the harness's own worker on its real binary (refused in a test run). Tests inject one. */
  readonly runner?: ProbeRunner;
  /** Default: `<binary> --version` through the CLI. */
  readonly version?: () => Promise<string | null>;
  readonly cli?: HarnessCli;
}

export interface CaptureResult {
  readonly harness: GlobalHarness;
  readonly probeModel: string;
  readonly launches: string;
  readonly ran: boolean;
  readonly version: string | null;
  readonly status: string | null;
  readonly signal: ModelSignal | null;
  readonly rows: readonly string[];
  readonly record: string | null;
  readonly error: string | null;
}

/** Runs one harness's capture. Never throws; `error` says what stopped it. */
export async function captureModelSignals(options: CaptureOptions): Promise<CaptureResult> {
  const probe = MODEL_SIGNAL_CASES[options.harness];
  const cli = options.cli ?? defaultHarnessCli;
  const base = { harness: options.harness, probeModel: probe.probeModel, launches: probe.launches, ran: false, version: null, status: null, signal: null, record: null };
  const rowsNow = async (version: string | null): Promise<readonly string[]> => modelSignalRows(options.harness, await loadModelSignalCapture(options.home, options.harness), version);
  if (options.runner === undefined && !liveHarnessAllowed()) {
    return { ...base, rows: await rowsNow(null), error: 'the model-signal capture starts the real harness, which is disabled in a test run (JEVRIS_NO_LIVE_HARNESS, JEVRIS_TEST or a test runner) unless JEVRIS_LIVE_HARNESS=1 is set' };
  }
  if (options.runner === undefined && !cli.available(LAUNCHER[options.harness])) {
    return { ...base, rows: await rowsNow(null), error: `${LAUNCHER[options.harness]} is not on PATH; install ${options.harness} first` };
  }
  let cwd: string | null = null;
  try {
    const version = await (options.version ?? (() => probeHarnessVersion(options.harness, cli).catch(() => null)))();
    const runner = options.runner ?? defaultRunner(options.harness);
    cwd = await mkdtemp(join(tmpdir(), `jevris-model-signal-${options.harness}-`));
    const run = await runner({ prompt: PROBE_PROMPT, model: probe.probeModel, cwd, allowedTools: [], maxTurns: 1, maxBudgetUsd: PROBE_BUDGET_USD, timeoutMs: PROBE_TIMEOUT_MS });
    const signal = run.modelSignal === null ? null : { id: run.modelSignal.id, channel: run.modelSignal.channel, shape: [...run.modelSignal.shape] };
    const ran = { ...base, ran: true, version, status: run.status, signal };
    if (!RECORDED_STATUSES.has(run.status)) return { ...ran, rows: await rowsNow(version), error: `nothing recorded: the probe ended ${run.status}, not on the harness's answer` };
    const capture: ModelSignalCapture = { schema: MODEL_SIGNALS_SCHEMA, harness: options.harness, version, capturedAt: new Date(options.nowMs ?? Date.now()).toISOString(), probeModel: probe.probeModel, status: run.status, signal };
    const file = modelSignalsFile(options.home, options.harness);
    const written = await writePrivateFile(file, `${JSON.stringify(capture, null, 2)}\n`);
    if (!written.ok) return { ...ran, rows: await rowsNow(version), error: 'the capture record could not be written' };
    return { ...ran, rows: modelSignalRows(options.harness, capture, version), record: file, error: run.status === 'completed' ? `the harness ran the nonexistent model ${probe.probeModel}; no signal to record` : null };
  } catch (error) {
    return { ...base, rows: await rowsNow(null), error: `capture failed: ${String((error as { message?: unknown }).message ?? error).slice(0, 200)}` };
  } finally {
    if (cwd !== null) await rm(cwd, { recursive: true, force: true });
  }
}

export function formatCapture(result: CaptureResult): string {
  const lines = [`jevris certify --model-signals ${result.harness}: ${result.record !== null && result.error === null ? 'captured' : 'not captured'}${result.version === null ? '' : ` (version ${result.version})`}`];
  lines.push(`  launches: ${result.launches}`);
  if (result.ran) {
    lines.push(`  status: ${result.status ?? ''}`);
    lines.push(result.signal === null ? '  signal: none of the known signals' : `  signal: ${result.signal.id} (${result.signal.channel}); event keys: ${result.signal.shape.join(', ') || 'none'}`);
  }
  for (const row of result.rows) lines.push(`  ${row}`);
  if (result.record !== null) lines.push(`  record: ${result.record}`);
  if (result.error !== null) lines.push(`  ${result.error}`);
  return `${lines.join('\n')}\n`;
}

/** The harnesses `--harness all` captures: every one whose binary is on PATH. */
export function captureTargets(cli: HarnessCli = defaultHarnessCli): readonly GlobalHarness[] {
  return (Object.keys(MODEL_SIGNAL_CASES) as GlobalHarness[]).filter((harness) => cli.available(LAUNCHER[harness]));
}

/**
 * `jevris certify --harness <name|all> --model-signals`. Prints what each case launches before
 * it starts. Exit 0 when every capture was recorded; 1 otherwise.
 */
export async function runModelSignalCapture(
  options: { readonly home: string; readonly json: boolean; readonly harness?: GlobalHarness; readonly cli?: HarnessCli; readonly runner?: (harness: GlobalHarness) => ProbeRunner; readonly version?: (harness: GlobalHarness) => Promise<string | null>; readonly nowMs?: number },
  write: (text: string) => void,
): Promise<number> {
  const cli = options.cli ?? defaultHarnessCli;
  const targets = options.harness === undefined ? captureTargets(cli) : [options.harness];
  if (targets.length === 0) {
    write(options.json ? `${JSON.stringify({ ok: false, results: [], error: 'no harness binary on PATH to capture' })}\n` : 'jevris certify --model-signals: no harness binary on PATH to capture\n');
    return COMMAND_EXIT_CODES.negative;
  }
  const results: CaptureResult[] = [];
  for (const harness of targets) {
    if (!options.json) write(`jevris certify --model-signals ${harness}: starting ${MODEL_SIGNAL_CASES[harness].launches}\n`);
    const result = await captureModelSignals({
      home: options.home,
      harness,
      cli,
      ...(options.runner === undefined ? {} : { runner: options.runner(harness) }),
      ...(options.version === undefined ? {} : { version: () => (options.version as (h: GlobalHarness) => Promise<string | null>)(harness) }),
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    });
    results.push(result);
    if (!options.json) write(formatCapture(result));
  }
  const ok = results.every((result) => result.record !== null && result.error === null);
  if (options.json) write(`${JSON.stringify(options.harness === undefined ? { ok, results } : { ok, ...results[0] })}\n`);
  return ok ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.negative;
}
