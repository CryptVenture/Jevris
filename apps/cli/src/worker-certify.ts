/**
 * worker.route certification (owner approval 2026-09-26, DOMAINS 72ff950): "certified pending
 * first use". Certify proves the `<harness>.worker` actuator with no model call:
 *
 * - The binary: the version (certify's own probe), and every flag the worker port passes,
 *   read from the harness's help. A flag the port relies on that the help does not list is named
 *   in the record's limitations, so the first real run is what proves it.
 * - The port: the nine §15.4 cases, run against a stand-in for the harness's headless stream
 *   (a node script in certify's temporary profile, never the real binary): event validation,
 *   duplicate delivery, cancellation, stale revision, output shape, permission preservation,
 *   user pin, offline fallback and unsupported capability.
 *
 * The first real run then checks its init before any tool runs (each port's `initCheck`), and
 * worker-evidence.ts records it: verified in use, or demoted with a background re-check.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConformanceCaseId } from './conformance-run.js';
import { LAUNCHER, type GlobalHarness, type HarnessCli } from './global-harness.js';
import { runAntigravityWorker } from './antigravity-worker.js';
import { runClaudeWorker } from './claude-worker.js';
import { runCodexWorker } from './codex-worker.js';
import { runKiloWorker } from './kilo-worker.js';
import { runOpencodeWorker } from './opencode-worker.js';
import type { OwnedWorkerInputBase } from './owned-session.js';

const HELP_TIMEOUT_MS = 15_000;

export interface WorkerFlagProbe {
  /** The help command, after the binary. */
  readonly help: readonly string[];
  /** Every flag the worker port passes that the help documents. */
  readonly flags: readonly string[];
  /** Flags the port passes that the help does not list (proved on first use). */
  readonly unlisted: readonly string[];
}

/** From each harness's help on this Mac (2026-09-26): claude 2.1.283, codex 0.157.1, opencode 1.18.32, kilo 7.7.9, agy 1.2.11. */
export const WORKER_FLAG_PROBES: Readonly<Record<GlobalHarness, WorkerFlagProbe>> = {
  claude: { help: ['--help'], flags: ['--print', '--output-format', '--verbose', '--model', '--max-budget-usd', '--allowedTools', '--disallowedTools', '--strict-mcp-config', '--effort'], unlisted: ['--max-turns'] },
  codex: { help: ['exec', '--help'], flags: ['--json', '--model', '--sandbox', '--skip-git-repo-check', '--config'], unlisted: [] },
  opencode: { help: ['run', '--help'], flags: ['--format', '--model', '--agent', '--dir', '--variant'], unlisted: [] },
  kilocode: { help: ['run', '--help'], flags: ['--format', '--model', '--agent', '--dir', '--variant'], unlisted: [] },
  antigravity: { help: ['--help'], flags: ['--input-format', '--output-format', '--model', '--sandbox', '--print-timeout', '--effort'], unlisted: [] },
};

/** What the record says about each harness's worker (limitations, at most a few lines). */
export function workerLimitations(harness: GlobalHarness): string[] {
  const out = ['worker.route is certified pending first use: flags and the port are proven with no model call; the first real run checks its init before any tool runs.'];
  const unlisted = WORKER_FLAG_PROBES[harness].unlisted;
  if (unlisted.length > 0) out.push(`The worker passes ${unlisted.join(', ')}, which ${LAUNCHER[harness]} --help does not list; the first real run proves it.`);
  if (harness === 'antigravity') out.push('Antigravity worker: a read-only grant is enforced after the fact (the run is killed), not before; tool pre-approval lives only in ~/.gemini, which Jevris never writes.');
  if (harness === 'codex') out.push('Codex worker: the stream names no cwd, model or permissions; the first-use check is the thread start, and the rest is the argv Jevris builds.');
  return out;
}

/** The flags the help does not list, from the help text. */
export function missingFlags(helpText: string, flags: readonly string[]): string[] {
  return flags.filter((flag) => !new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}(?=[\\s,=<[]|$)`, 'm').test(helpText));
}

/** Reads the worker's flags from the harness help (no model call). */
export async function workerFlagCheck(harness: GlobalHarness, cli: HarnessCli, env: { readonly [key: string]: string }): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const probe = WORKER_FLAG_PROBES[harness];
  const bin = LAUNCHER[harness];
  const ran = await cli.run(bin, probe.help, HELP_TIMEOUT_MS, env);
  if (!ran.spawned) return { ok: false, detail: `${bin} ${probe.help.join(' ')}: not started` };
  const text = `${ran.stdout}\n${ran.stderr ?? ''}`;
  const missing = missingFlags(text, probe.flags);
  return missing.length === 0 ? { ok: true, detail: `${bin} ${probe.help.join(' ')} lists every worker flag (${probe.flags.length})` } : { ok: false, detail: `${bin} ${probe.help.join(' ')} does not list ${missing.join(', ')}` };
}

// ------------------------------------------------------------------ the port's nine cases

const STUB = `
const { appendFileSync, readFileSync } = require('node:fs');
const script = JSON.parse(readFileSync(process.env.JEVRIS_WORKER_STUB_SCRIPT, 'utf8'));
const jevris = {};
for (const k of Object.keys(process.env)) if (/^(OPENCODE|KILO)_(CONFIG_CONTENT|PERMISSION)$/.test(k)) jevris[k] = process.env[k];
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', async () => {
  appendFileSync(process.env.JEVRIS_WORKER_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin, jevris }) + '\\n');
  const out = (line) => (typeof line === 'string' ? line : JSON.stringify(line).split('"@CWD"').join(JSON.stringify(process.cwd())));
  for (const line of script.lines) process.stdout.write(out(line) + '\\n');
  if (script.sleepMs) await new Promise((r) => setTimeout(r, script.sleepMs));
  process.exitCode = 0;
});
`;

interface Scenario {
  readonly run: (input: OwnedWorkerInputBase) => Promise<{ readonly status: string; readonly sessionId: string | null; readonly events: number; readonly turns: number | null; readonly usage: unknown }>;
  readonly model: string;
  readonly session: string;
  readonly happy: readonly unknown[];
  /** An event naming another session, after the first. */
  readonly stale: unknown;
  /** Which argv or environment facts a read-only grant must show. */
  readonly readOnly: (call: StubCall, outcome: { readonly status: string }) => string | null;
  readonly bypass: readonly string[];
  /** The stdin the port must write for a prompt. */
  readonly stdin: (prompt: string) => string;
}

interface StubCall {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly jevris: { readonly [key: string]: string };
}

const after = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

function opencodeReadOnly(prefix: string) {
  return (call: StubCall): string | null => {
    let rules: { readonly [key: string]: string } = {};
    try {
      rules = (JSON.parse(call.jevris[`${prefix}_CONFIG_CONTENT`] ?? '{}') as { agent?: { [k: string]: { permission?: { [k: string]: string } } } }).agent?.['jevris-worker']?.permission ?? {};
    } catch {
      return 'CONFIG_NOT_JSON';
    }
    if (rules['*'] !== 'deny') return 'NOT_DENY_BY_DEFAULT';
    if (rules['edit'] === 'allow' || rules['bash'] === 'allow') return 'WRITE_ALLOWED_READ_ONLY';
    return null;
  };
}

function scenario(harness: GlobalHarness): Scenario {
  switch (harness) {
    case 'claude': {
      const init = { type: 'system', subtype: 'init', session_id: 'sess-cert', cwd: '@CWD', model: 'claude-cert-model', permissionMode: 'default', apiKeySource: 'none', tools: ['Read'] };
      return {
        run: runClaudeWorker,
        model: 'claude-cert-model',
        session: 'sess-cert',
        happy: [init, { type: 'assistant', session_id: 'sess-cert', message: { model: 'claude-cert-model', content: [] } }, { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-cert', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }],
        stale: { type: 'assistant', session_id: 'sess-other', message: { model: 'claude-cert-model', content: [] } },
        readOnly: (call) => (after(call.argv, '--allowedTools') !== 'Read,Grep' ? 'ALLOWED_TOOLS' : !(after(call.argv, '--disallowedTools') ?? '').includes('WebFetch') ? 'WEB_NOT_DISALLOWED' : null),
        bypass: ['--dangerously-skip-permissions', '--permission-mode'],
        stdin: (prompt) => prompt,
      };
    }
    case 'codex':
      return {
        run: runCodexWorker,
        model: 'gpt-cert-model',
        session: 'thr_cert',
        happy: [{ type: 'thread.started', thread_id: 'thr_cert' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'c1', type: 'command_execution', status: 'completed' } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }],
        stale: { type: 'thread.started', thread_id: 'thr_other' },
        readOnly: (call) => (after(call.argv, '--sandbox') !== 'read-only' ? 'SANDBOX_NOT_READ_ONLY' : null),
        bypass: ['--dangerously-bypass-approvals-and-sandbox', 'danger-full-access', '--full-auto'],
        stdin: (prompt) => prompt,
      };
    case 'opencode':
    case 'kilocode': {
      const s = 'ses_cert';
      return {
        run: harness === 'opencode' ? runOpencodeWorker : runKiloWorker,
        model: 'xai/cert-model',
        session: s,
        happy: [
          { type: 'step_start', sessionID: s, part: { id: 'p1', type: 'step-start' } },
          { type: 'text', sessionID: s, part: { id: 'p2', type: 'text', text: 'ok' } },
          { type: 'step_finish', sessionID: s, part: { id: 'p3', type: 'step-finish', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
        ],
        stale: { type: 'text', sessionID: 'ses_other', part: { id: 'p9', type: 'text', text: 'x' } },
        readOnly: opencodeReadOnly(harness === 'opencode' ? 'OPENCODE' : 'KILO'),
        bypass: ['--auto', '--yolo', '--dangerously-skip-permissions'],
        stdin: (prompt) => prompt,
      };
    }
    case 'antigravity': {
      const c = 'conv-cert';
      return {
        run: runAntigravityWorker,
        model: 'cert-model',
        session: c,
        happy: [
          { event: 'init', conversation_id: c, init: { cwd: '@CWD', tools: [], permission_mode: 'request-review', model: 'cert-model' } },
          { event: 'step_update', step_update: { conversation_id: c, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'view_file' } },
          { event: 'result', result: { conversation_id: c, status: 'SUCCESS', response: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } } },
        ],
        stale: { event: 'step_update', step_update: { conversation_id: 'conv-other', step_index: 2, state: 'DONE', step_type: 'agent_response' } },
        readOnly: (_call, outcome) => (outcome.status === 'completed' ? null : 'READ_ONLY_RUN_FAILED'),
        bypass: ['--dangerously-skip-permissions'],
        stdin: (prompt) => `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
      };
    }
  }
}

/**
 * Runs the nine §15.4 cases for the harness's worker port against a stand-in in `dir` (a
 * temporary folder). Returns each case with null (passed) or a reason code.
 */
export async function workerConformance(harness: GlobalHarness, dir: string): Promise<Map<ConformanceCaseId, string | null>> {
  const sc = scenario(harness);
  const box = join(dir, `worker-${harness}`);
  await mkdir(join(box, 'work'), { recursive: true });
  const stub = join(box, 'stub.cjs');
  const log = join(box, 'calls.log');
  await writeFile(stub, STUB);
  const work = join(box, 'work');
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|^OPENCODE_|^KILO_/.test(key)) env[key] = value;
  let n = 0;
  const calls = async (): Promise<StubCall[]> => {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StubCall);
    } catch {
      return [];
    }
  };
  const play = async (lines: readonly unknown[], extra: Partial<OwnedWorkerInputBase> = {}, sleepMs = 0) => {
    n += 1;
    const script = join(box, `script-${n}.json`);
    await writeFile(script, JSON.stringify({ lines, sleepMs }));
    return sc.run({ prompt: 'Jevris certify: worker case.\nLine two.', model: sc.model, cwd: work, allowedTools: ['Read', 'Grep', 'Edit'], maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 20_000, command: { file: process.execPath, args: [stub] }, env: { ...env, JEVRIS_WORKER_STUB_SCRIPT: script, JEVRIS_WORKER_STUB_LOG: log }, ...extra });
  };
  const out = new Map<ConformanceCaseId, string | null>();
  const guard = async (id: ConformanceCaseId, check: () => Promise<string | null>): Promise<void> => {
    try {
      out.set(id, await check());
    } catch {
      out.set(id, 'CASE_THREW');
    }
  };
  try {
    const happy = await play(sc.happy);
    await guard('output-shape', async () => {
      const call = (await calls()).at(-1);
      if (happy.status !== 'completed') return 'NOT_COMPLETED';
      if (call === undefined || call.stdin !== sc.stdin('Jevris certify: worker case.\nLine two.')) return 'PROMPT_NOT_ON_STDIN';
      if (call.argv.some((arg) => arg.includes('Jevris certify: worker case.'))) return 'PROMPT_IN_ARGV';
      return happy.sessionId === sc.session ? null : 'SESSION_NOT_REPORTED';
    });
    await guard('event-validation', async () => {
      const noisy = await play(['not json', '[1,2]', '{"no":"type"}', ...sc.happy]);
      if (noisy.status !== 'completed' || noisy.events !== happy.events) return 'NOISE_NOT_IGNORED';
      const junk = await play(['not json', '{"no":"type"}']);
      return junk.status === 'completed' ? 'JUNK_COMPLETED' : null;
    });
    await guard('duplicate-delivery', async () => {
      const twice = await play(sc.happy.flatMap((line) => [line, line]));
      if (twice.status !== 'completed') return 'NOT_COMPLETED';
      return twice.turns === happy.turns && JSON.stringify(twice.usage) === JSON.stringify(happy.usage) ? null : 'DUPLICATE_COUNTED';
    });
    await guard('cancellation', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const before = (await calls()).length;
      const running = play(sc.happy.slice(0, 1), { signal: controller.signal }, 10_000);
      // Abort once the stand-in has read its prompt (it then sleeps), not after a fixed delay,
      // so a loaded machine cannot make the abort land before the session exists.
      for (let waited = 0; waited < 5_000 && (await calls()).length === before; waited += 25) await new Promise<void>((resolve) => setTimeout(() => resolve(), 25));
      controller.abort();
      const aborted = await running;
      return aborted.status === 'aborted' && Date.now() - started < 8_000 ? null : 'NOT_ABORTED';
    });
    await guard('stale-revision', async () => {
      const stale = await play([...sc.happy.slice(0, 1), sc.stale, ...sc.happy.slice(1)]);
      return stale.sessionId === sc.session ? null : 'SESSION_REPLACED';
    });
    await guard('permission-preservation', async () => {
      const ro = await play(sc.happy, { allowedTools: ['Read', 'Grep'] });
      const call = (await calls()).at(-1);
      if (call === undefined) return 'NOT_STARTED';
      if (call.argv.some((arg) => sc.bypass.some((flag) => arg === flag || arg.includes(flag)))) return 'BYPASS_FLAG';
      return sc.readOnly(call, ro);
    });
    await guard('user-pin', async () => {
      const call = (await calls())[0];
      return call !== undefined && after(call.argv, '--model') === sc.model ? null : 'MODEL_NOT_AS_GIVEN';
    });
    await guard('offline-fallback', async () => {
      const missing = await sc.run({ prompt: 'x', model: sc.model, cwd: work, allowedTools: ['Read'], maxTurns: 1, maxBudgetUsd: 1, timeoutMs: 5_000, command: { file: join(box, 'no-such-binary') }, env });
      return missing.status === 'unsupported' ? null : 'MISSING_BINARY_NOT_UNSUPPORTED';
    });
    await guard('unsupported-capability', async () => {
      const before = (await calls()).length;
      const bad = await play(sc.happy, { effort: 'ultra' as never });
      return bad.status === 'refused' && (await calls()).length === before ? null : 'UNSUPPORTED_INPUT_STARTED';
    });
  } finally {
    await rm(box, { recursive: true, force: true });
  }
  return out;
}

/** worker.route for certify: the flags from the help and the port's nine cases. */
export async function workerRouteCheck(
  harness: GlobalHarness,
  cli: HarnessCli,
  env: { readonly [key: string]: string },
  dir: string,
): Promise<{ readonly passed: boolean; readonly reasonCode: string; readonly detail: string; readonly cases: readonly { readonly id: ConformanceCaseId; readonly passed: boolean; readonly reasonCode: string | null }[] }> {
  const flags = await workerFlagCheck(harness, cli, env);
  const results = await workerConformance(harness, dir);
  const cases = [...results.entries()].map(([id, reason]) => ({ id, passed: reason === null, reasonCode: reason }));
  const failed = cases.filter((item) => !item.passed);
  const passed = flags.ok && failed.length === 0 && cases.length === 9;
  const detail = !flags.ok ? flags.detail : failed.length > 0 ? `worker port cases failed: ${failed.map((item) => `${item.id} (${item.reasonCode ?? ''})`).join(', ')}` : `${flags.detail}; the worker port passed all ${cases.length} §15.4 cases; pending first use`;
  return { passed, reasonCode: !flags.ok ? 'WORKER_FLAG_MISSING' : 'WORKER_CONFORMANCE_FAILED', detail, cases };
}
