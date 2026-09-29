/**
 * Process entry of the hook launcher (bundled as dist/hook.mjs):
 *   node dist/hook.mjs --harness <claude|kilo|codex|opencode|agy> [--event <Native>]
 *
 * Reads one native hook input from stdin (capped at NATIVE_READ_CAP bytes; the launcher fits a
 * larger one under HARNESS_INPUT_CAP by cutting long strings, with a marker), runs the
 * launcher and writes exactly one response. It always exits 0, and a watchdog makes sure it
 * answers before the deadline even if stdin never closes or a call hangs. Diagnostics go to
 * stderr only when JEVRIS_HOOK_DEBUG=1, and they carry reason codes, never event content.
 */
import { statSync } from 'node:fs';
import type { LauncherName } from '@jevris/contracts';
import * as antigravity from '@jevris/adapter-antigravity';
import * as claude from '@jevris/adapter-claude-code';
import * as codex from '@jevris/adapter-codex';
import * as kilocode from '@jevris/adapter-kilocode';
import * as opencode from '@jevris/adapter-opencode';
import { appendHookLatency, ensureSidecar, sidecarRequest } from '@jevris/sidecar/client';
import { endpointRedirected } from './endpoint-redirect.js';
import { NATIVE_READ_CAP, countedHookReason, deadlineMs, parseLauncherArgs, runLauncher, type HarnessAdapter, type LauncherSidecar, type ShimMissRecord } from './launcher.js';

const startedAtMs = Date.now();

/** A file's size (stat only; the transcript is never read), or null. */
function fileSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export const ADAPTERS: Readonly<Record<LauncherName, HarnessAdapter>> = {
  claude,
  kilo: kilocode,
  codex,
  opencode,
  agy: antigravity,
};

const sidecar: LauncherSidecar = {
  ensure: (input) => ensureSidecar(input),
  request: (input) => sidecarRequest(input),
};

/** The harness id a launcher name answers for (the store's latency counters name harness ids). */
const HARNESS_ID: Readonly<Record<LauncherName, string>> = { claude: 'claude', kilo: 'kilocode', codex: 'codex', opencode: 'opencode', agy: 'antigravity' };


/** At most this many shim-miss lines per delivery; the file's own 64 KiB cap still applies. */
const SHIM_MISS_LINES = 64;

let harness: LauncherName | null = null;
let finished = false;

function finish(stdout: string, reason?: string, shimMisses: readonly ShimMissRecord[] = []): void {
  if (finished) return;
  finished = true;
  // After the answer is written: one line for the sidecar to fold into its latency counters.
  // B's appendHookLatency is synchronous, tiny and never throws.
  const record = (): void => {
    if (harness === null) return;
    const atMs = Date.now();
    if (reason !== undefined && countedHookReason(reason)) {
      appendHookLatency({ env: process.env, harness: HARNESS_ID[harness], reasonCode: reason, elapsedMs: Math.max(0, atMs - startedAtMs), atMs });
    }
    // G16: misses a Kilo or OpenCode shim counted on its side, one line each, at its longest wait.
    let lines = 0;
    for (const miss of shimMisses) {
      for (let i = 0; i < miss.count && lines < SHIM_MISS_LINES; i += 1, lines += 1) {
        appendHookLatency({ env: process.env, harness: HARNESS_ID[harness], reasonCode: miss.reasonCode, elapsedMs: miss.maxMs, atMs });
      }
    }
  };
  if (stdout.length === 0) {
    record();
    process.exit(0);
  }
  process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`, () => {
    record();
    process.exit(0);
  });
}

function log(line: string): void {
  if (process.env['JEVRIS_HOOK_DEBUG'] === '1') process.stderr.write(`${line}\n`);
}

/** Reads stdin up to the cap. Over the cap, or on a read error: null (the input is refused). */
async function readInput(): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      total += bytes.byteLength;
      if (total > NATIVE_READ_CAP) {
        process.stdin.destroy();
        return null;
      }
      chunks.push(bytes);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    return null;
  }
}

async function runHookProcess(): Promise<void> {
  const args = parseLauncherArgs(process.argv.slice(2));
  if (args === null) {
    log('jevris-hook USAGE: --harness <claude|kilo|codex|opencode|agy> [--event <name>]');
    finish('');
    return;
  }
  harness = args.harness;
  const adapter = ADAPTERS[args.harness];
  const budget = deadlineMs(process.env);
  // Watchdog: answer "no decision" before the deadline whatever else is still pending.
  const watchdog = setTimeout(() => {
    log(`jevris-hook ${args.harness} WATCHDOG`);
    let text = '';
    try {
      text = adapter.protocolResponse(null, { kind: 'observe' });
    } catch {
      text = '';
    }
    finish(typeof text === 'string' ? text : '', 'HOOK_WATCHDOG');
  }, budget + 200);
  const input = await readInput();
  const result = await runLauncher(
    args,
    input,
    { adapters: ADAPTERS, sidecar, env: process.env, cwd: () => process.cwd(), nowMs: () => Date.now(), log, fileSize, endpointRedirected: (harness, provider, workspace) => endpointRedirected(harness, provider, workspace, process.env) },
    startedAtMs,
  );
  clearTimeout(watchdog);
  finish(result.stdout, result.reason, result.shimMisses);
}

runHookProcess().catch(() => finish(''));
