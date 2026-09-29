/**
 * The Codex owned session (CDX-04, SSOT §15.1, E32, HAR-CODEX-05): a worker port for D's
 * `runLeasedTask`, next to the Claude Agent SDK port.
 *
 * One run is one Codex thread with one turn, through the Codex exec protocol that the Codex
 * TypeScript SDK drives (`codex exec --json`, its documented name for `--experimental-json`; prompt on stdin, JSONL
 * ThreadEvents on stdout). It uses the Codex CLI the user installed and certified, with the
 * user's CODEX_HOME, so the installed Jevris Codex plugin's hooks run in the session too: its
 * SessionStart and compaction hooks rehydrate the capsule exactly as in an interactive session.
 *
 * - The model is selected at turn start (`--model`); an active turn is never re-steered.
 * - Cancellation: the caller's AbortSignal, the wall-clock timeout and the step cap each kill the
 *   whole process tree.
 * - Native permissions stay authoritative. The Codex sandbox is `read-only` unless the grant
 *   includes a write tool, then `workspace-write` (the task worktree only). Network access and
 *   web search are off. `approval_policy="never"` means nothing is ever approved on anyone's
 *   behalf: an action that needs approval fails back to the model. Jevris never passes
 *   `--dangerously-bypass-approvals-and-sandbox` or `danger-full-access`, and Codex's own
 *   managed requirements still apply on top.
 * - Lease, fencing, the kill-switch hold and the owned-effect record are D's `runLeasedTask`,
 *   the same for every port: this module only runs the session.
 *
 * Codex reports tokens, not money, and not the model that answered: `costUsd` and
 * `actualModel` stay null (unknown), so the lease releases its spend as uncertain. Codex has no
 * budget cap of its own; the reservation D holds for the lease bounds the run instead.
 *
 * Auth (owner decision 2026-09-26): a ChatGPT subscription login and an API key are both
 * first-class. `auth: 'subscription'` removes every vendor key from the child's environment and
 * first asks `codex login status` (read-only): a stored API-key login or no login refuses the
 * run before any model call. `auth: 'api-key'` needs CODEX_API_KEY or OPENAI_API_KEY in the
 * environment (offered to `codex exec` as CODEX_API_KEY).
 *
 * Access limits (R65, design 5.2): Codex's exec stream carries a limit only as text. A run with no
 * successful turn whose `turn.failed` message, else `error` message, matches a pinned X pattern
 * is `access-limit` (or `overloaded`), with the pattern id and a fixed reason; it is not the
 * task's failure. The last 4 KiB of stderr count only for a run that exited non-zero with no error
 * event, and only for the timed patterns (a usage window, a rate limit, an overload). A run through
 * a custom provider or OPENAI_BASE_URL reports none (OP-12).
 */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { foreignHomeRefusal, isTripwireBinary, launchStreaming } from './live-harness.js';
import type { AccessLimitFinding, AccessSignalWire, ModelRegistry } from '@jevris/contracts';
import { codexAccessSignal, codexStreamAccess, noteCodexAccess, portAccess } from './access-signal.js';
export { codexAccessSignal, codexStreamAccess, codexTranscriptAccess, noteCodexAccess, type CodexStreamAccess } from './access-signal.js';
import { parseCodexLoginStatus, workerEnv, type AuthMode } from './harness-auth.js';
import { harnessModelChoice, type HarnessModelChoice } from './harness-model.js';
import { count, initFailed, INIT_OK, interruptedStatus, jsonLine, nearestEffort, OWNED_GRANTABLE_TOOLS, OWNED_WRITE_TOOLS, rec, runStreamingSession, sessionIdReporter, validateOwnedInput, type InitCheck, type OwnedWorkerInputBase, type OwnedWorkerStatus, type WorkerEffort } from './owned-session.js';
import { codexModelSignal, eventShape, modelUnavailableOf, modelUnavailableText, withCertifiedSignals, type ModelSignal, type ModelUnavailable } from './model-signals.js';
import { portEvidence, withWorkerEvidence, type WorkerEvidenceOptions } from './worker-evidence.js';

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number): void;

export const CODEX_BINARY = 'codex';
export const CODEX_MISSING_MESSAGE = 'unsupported: install the Codex CLI (codex) and run jevris install --harness codex';

/** The tool names D grants owned workers (the Claude names); the same list is accepted here. */
export const CODEX_GRANTABLE_TOOLS: readonly string[] = OWNED_GRANTABLE_TOOLS;
const WRITE_TOOLS = OWNED_WRITE_TOOLS;
/** Codex's `model_reasoning_effort` levels (0.157). C's `max` maps to `xhigh`, its top level. */
export const CODEX_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
/** Item types that are one agent step (a tool call); the step cap counts these. */
const STEP_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);
const MAX_RESULT_TEXT = 8_000;
/** The most of an error message read in memory to classify it; none of it is kept. */

export type CodexWorkerStatus = OwnedWorkerStatus;

/**
 * `maxTurns` is the step cap: completed tool calls (commands, file changes, MCP calls,
 * searches). `maxBudgetUsd` is validated like the Claude port; Codex reports no cost, so D's
 * reservation bounds spend.
 */
export interface CodexWorkerInput extends OwnedWorkerInputBase {
  /** Receives each event's type (and item type), never content. */
  readonly onEvent?: (event: { readonly type: string; readonly itemType?: string }) => void;
}

export interface CodexWorkerOutcome {
  readonly status: CodexWorkerStatus;
  readonly reason: string;
  /** The Codex thread id. */
  readonly sessionId: string | null;
  readonly requestedModel: string;
  /** Codex exec does not report the answering model: always null (unknown, never guessed). */
  readonly actualModel: string | null;
  /** Codex reports no cost: always null. */
  readonly costUsd: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadInputTokens: number; readonly cacheCreationInputTokens: number } | null;
  /** Completed agent steps (tool calls). */
  readonly turns: number | null;
  readonly durationMs: number;
  readonly resultText: string | null;
  /** How the session was sandboxed. */
  readonly sandbox: 'read-only' | 'workspace-write';
  readonly events: number;
  /** The auth the run used: the decided mode once checked, 'unknown' when no mode was decided. */
  readonly authMode: AuthMode | 'unknown';
  /** The `model_reasoning_effort` passed, or null when no effort was asked. */
  readonly effort: string | null;
  /**
   * The first-use check: the first event is `thread.started` with a thread id. Codex's stream
   * names no cwd, model or permissions, so the rest of the check is the argv Jevris built.
   */
  readonly initCheck: InitCheck | null;
  /** The found-gone signal a turn.failed or error event showed (model-signals.ts); null when none. */
  readonly modelSignal: ModelSignal | null;
  /** For `model-unavailable`: C's reason, the port and the auth mode, for D to record. */
  readonly modelUnavailable?: ModelUnavailable;
  /** For `access-limit`: when the limit lifts (ISO), when the text states a reset core accepts. */
  readonly resetAt?: string;
  /** For `access-limit` and `overloaded` (R65): the pinned pattern the error text matched, never the text. */
  readonly accessSignal?: AccessSignalWire;
  /** This port's own classification of `accessSignal`: its claim, never recorded as such. */
  readonly accessLimit?: AccessLimitFinding;
}

export function validateCodexWorkerInput(input: CodexWorkerInput): string | null {
  return validateOwnedInput(input, { model: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ });
}

/** The `model_reasoning_effort` for C's effort, or null. */
export function codexEffort(effort: WorkerEffort | undefined): string | null {
  return nearestEffort(effort, CODEX_EFFORTS);
}

/** The sandbox a grant maps to: a write tool is the only way to get a writable worktree. */
export function codexSandbox(allowedTools: readonly string[]): 'read-only' | 'workspace-write' {
  return allowedTools.some((tool) => WRITE_TOOLS.has(tool)) ? 'workspace-write' : 'read-only';
}

/** The exact `codex` argv for one owned turn (the prompt goes on stdin, never argv). */
export function codexExecArgs(model: string, sandbox: 'read-only' | 'workspace-write', effort: string | null = null): readonly string[] {
  return [
    'exec',
    '--json',
    '--model',
    model,
    '--sandbox',
    sandbox,
    '--skip-git-repo-check',
    '--config',
    'approval_policy="never"',
    '--config',
    'sandbox_workspace_write.network_access=false',
    '--config',
    'web_search="disabled"',
    ...(effort === null ? [] : ['--config', `model_reasoning_effort="${effort}"`]),
  ];
}

/**
 * How Codex runs `model` at C's `effort` (routing design R6, R18; harness-model.ts): the registry's
 * Codex id and its `model_reasoning_effort` levels for the model. An id the registry does not know
 * runs as given at the nearest CODEX_EFFORTS level; a registry model Codex names no id for (another
 * provider's) is null.
 */
export function codexModelChoice(model: string, effort?: WorkerEffort, registry?: ModelRegistry): HarnessModelChoice | null {
  return harnessModelChoice('codex', model, effort, { ...(registry === undefined ? {} : { registry }), fallbackLevels: CODEX_EFFORTS, unregistered: (id) => id });
}

/** True for a registry model Codex serves (its provider's access row, or its own Codex row). */
export function isCodexModel(model: string, registry?: ModelRegistry): boolean {
  return harnessModelChoice('codex', model, undefined, { ...(registry === undefined ? {} : { registry }), fallbackLevels: CODEX_EFFORTS, unregistered: () => null }) !== null;
}

function refusedOutcome(input: Pick<CodexWorkerInput, 'model' | 'allowedTools'>, status: CodexWorkerStatus, reason: string): CodexWorkerOutcome {
  return {
    status,
    reason,
    sessionId: null,
    requestedModel: typeof input.model === 'string' ? input.model : '',
    actualModel: null,
    costUsd: null,
    usage: null,
    turns: null,
    durationMs: 0,
    resultText: null,
    sandbox: Array.isArray(input.allowedTools) ? codexSandbox(input.allowedTools) : 'read-only',
    events: 0,
    authMode: 'unknown',
    effort: null,
    initCheck: null,
    modelSignal: null,
  };
}

const CONFIG_CAP = 262_144;
/** A top-level `model_provider` other than OpenAI's, or an OpenAI base URL, in a Codex config file. */
const CUSTOM_PROVIDER = /^\s*(?:model_provider\s*=\s*["'](?!openai["'])|openai_base_url\s*=)/m;

async function redirectingConfig(file: string): Promise<boolean> {
  const info = await lstat(file).catch(() => null);
  if (info === null) return false;
  if (!info.isFile() || info.size > CONFIG_CAP) return true;
  const text = await readFile(file, 'utf8').catch(() => null);
  return text === null || CUSTOM_PROVIDER.test(text);
}

/**
 * Whether the run reaches another party than OpenAI (OP-12): OPENAI_BASE_URL in the child's
 * environment, or a custom `model_provider` (or `openai_base_url`) in the Codex home's
 * `config.toml` or the workspace's `.codex/config.toml`. An access signal from such a run names
 * no known party, so the port reports none. A config file that cannot be read counts as redirected.
 */
export async function codexEndpointRedirected(cwd: string, env: { readonly [key: string]: string | undefined }): Promise<boolean> {
  if ((env['OPENAI_BASE_URL'] ?? '') !== '') return true;
  const codexHome = (env['CODEX_HOME'] ?? '') !== '' ? (env['CODEX_HOME'] as string) : (env['HOME'] ?? '') !== '' ? join(env['HOME'] as string, '.codex') : null;
  if (codexHome !== null && (await redirectingConfig(join(codexHome, 'config.toml')))) return true;
  return redirectingConfig(join(cwd, '.codex', 'config.toml'));
}

/** `codex login status` with the run's binary and environment (read-only, bounded). */
async function loginStatus(file: string, lead: readonly string[], env: { readonly [key: string]: string }, cwd: string): Promise<ReturnType<typeof parseCodexLoginStatus> | 'missing'> {
  let text = '';
  const launched = launchStreaming(file, [...lead, 'login', 'status'], { cwd, env, input: '', onLine: (line) => (text += `${line}\n`) });
  const timer = setTimeout(() => launched.kill(), 15_000);
  const exit = await launched.done;
  clearTimeout(timer);
  if (!exit.spawned) return 'missing';
  // Codex has printed the status on stderr in some versions.
  return parseCodexLoginStatus(text.trim() === '' ? await launched.stderr : text);
}

export async function runCodexWorker(input: CodexWorkerInput): Promise<CodexWorkerOutcome> {
  const invalid = validateCodexWorkerInput(input);
  if (invalid !== null) return refusedOutcome(input, 'refused', `invalid ${invalid}`);
  if (input.signal?.aborted === true) return refusedOutcome(input, 'aborted', 'aborted before start');
  const sandbox = codexSandbox(input.allowedTools);
  const file = input.command?.file ?? CODEX_BINARY;
  const choice = codexModelChoice(input.model, input.effort, input.registry);
  if (choice === null) return refusedOutcome(input, 'refused', `refused: Codex names no model for ${input.model}; it serves OpenAI models`);
  const effort = choice.effortToken;
  const args = [...(input.command?.args ?? []), ...codexExecArgs(choice.id, sandbox, effort)];
  const env = workerEnv('codex', input.auth, input.env ?? process.env);
  if (input.auth === 'api-key' && (env['CODEX_API_KEY'] ?? '') === '') return refusedOutcome(input, 'refused', 'refused: api-key mode needs CODEX_API_KEY or OPENAI_API_KEY in the environment');
  // The real `codex login status` reads the OS keychain: never under a HOME that is not the
  // account's (a dialog on the person's screen). A stub (tests) is always asked.
  if (input.auth === 'subscription' && !(isTripwireBinary(file) && foreignHomeRefusal(env) !== null)) {
    const login = await loginStatus(file, input.command?.args ?? [], env, input.cwd);
    if (login === 'missing') return refusedOutcome(input, 'unsupported', CODEX_MISSING_MESSAGE);
    if (login === 'api-key') return refusedOutcome(input, 'refused', 'refused: subscription mode, but Codex holds an API-key login; run codex login to sign in with ChatGPT');
    if (login === 'signed-out') return refusedOutcome(input, 'refused', 'refused: subscription mode, but Codex is not signed in; run codex login');
  }

  let sessionId: string | null = null;
  const reportSession = sessionIdReporter(input.onSessionId);
  let usage: CodexWorkerOutcome['usage'] = null;
  let completed = false;
  /** R80: the failure as fixed text; the message is matched in memory, and only the pattern id is kept. */
  let failure: string | null = null;
  const access = codexStreamAccess();
  let resultText: string | null = null;
  let events = 0;
  const steps = new Set<string>();
  let stepCapHit = false;
  let initCheck: InitCheck | null = null;
  let modelSignal: ModelSignal | null = null;
  const noteSignal = (message: unknown, event: { readonly [key: string]: unknown }): void => {
    if (modelSignal !== null || typeof message !== 'string') return;
    const id = codexModelSignal(message);
    if (id !== null) modelSignal = { id, channel: 'event', shape: eventShape(event) };
  };

  const onLine = (line: string, stop: () => void): void => {
    const event = jsonLine(line); // Not an event (Codex may print notices): ignored, never fatal.
    if (event === undefined || typeof event['type'] !== 'string') return;
    events += 1;
    const type = event['type'] as string;
    const item = rec(event['item']);
    const itemType = typeof item?.['type'] === 'string' ? (item['type'] as string) : undefined;
    input.onEvent?.(itemType === undefined ? { type } : { type, itemType });
    if (initCheck === null && type !== 'error') initCheck = type === 'thread.started' && typeof event['thread_id'] === 'string' ? INIT_OK : initFailed('WORKER_INIT_SHAPE');
    if (type === 'thread.started' && sessionId === null && typeof event['thread_id'] === 'string') {
      sessionId = (event['thread_id'] as string).slice(0, 128);
      reportSession(sessionId);
    } else if (type === 'turn.completed') {
      completed = true;
      const u = rec(event['usage']);
      if (u !== undefined) {
        usage = {
          inputTokens: count(u['input_tokens']),
          outputTokens: count(u['output_tokens']),
          cacheReadInputTokens: count(u['cached_input_tokens']),
          cacheCreationInputTokens: count(u['cache_write_input_tokens']),
        };
      }
    } else if (type === 'turn.failed') {
      const message = rec(event['error'])?.['message'];
      noteSignal(message, event);
      failure ??= 'the turn failed';
      noteCodexAccess(event, type, access, Date.now());
    } else if (type === 'error') {
      const message = event['message'];
      noteSignal(message, event);
      failure ??= 'the stream reported an error';
      noteCodexAccess(event, type, access, Date.now());
    } else if (type === 'item.completed' && item !== undefined && itemType !== undefined) {
      const id = typeof item['id'] === 'string' ? (item['id'] as string) : null;
      if (itemType === 'agent_message' && typeof item['text'] === 'string') resultText = (item['text'] as string).slice(0, MAX_RESULT_TEXT);
      // A redelivered item (same id) is one step.
      if (STEP_ITEMS.has(itemType) && id !== null && !steps.has(id)) {
        steps.add(id);
        if (steps.size > input.maxTurns && !stepCapHit) {
          stepCapHit = true;
          stop();
        }
      }
    }
  };

  const end = await runStreamingSession({ file, args, cwd: input.cwd, env, input: input.prompt, timeoutMs: input.timeoutMs, ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.onStart === undefined ? {} : { onStart: input.onStart }), sessionId: () => sessionId, onLine });
  const { exit, stderr, durationMs } = end;
  const interrupted = interruptedStatus(end, input.timeoutMs);
  if (!exit.spawned) return { ...refusedOutcome(input, 'unsupported', CODEX_MISSING_MESSAGE), durationMs };

  const signal = modelSignal as ModelSignal | null;
  const unavailable = modelUnavailableOf('codex', signal, input.certifiedModelSignals, input.auth ?? 'unknown');
  let status: CodexWorkerStatus;
  let reason: string;
  const failed = failure as string | null;
  // Success wins (design 5.5): a run whose turn completed and whose exit was clean reports no signal.
  const succeeded = completed && failed === null && (exit.code === 0 || exit.code === null);
  const ended = interrupted === null && !stepCapHit && !succeeded;
  const stderrText = failed === null && exit.code !== 0 && exit.code !== null ? stderr : null;
  const candidate = ended ? codexAccessSignal(access.turnFailed, access.streamError, stderrText, Date.now()) : null;
  const limit = candidate !== null && !(await codexEndpointRedirected(input.cwd, env)) ? portAccess(candidate, input.auth ?? 'unknown', Date.now()) : null;
  if (interrupted !== null) [status, reason] = interrupted;
  else if (stepCapHit) [status, reason] = ['max-turns', `more than ${String(input.maxTurns)} steps`];
  else if (limit !== null) [status, reason] = [limit.status, limit.reason];
  else if (unavailable !== null) [status, reason] = ['model-unavailable', modelUnavailableText(input.model, unavailable)];
  else if (failed !== null) [status, reason] = ['failed', failed];
  // R80: stderr (remote text) never enters a reason.
  else if (!completed) [status, reason] = ['failed', exit.code !== 0 ? `codex exec exited with code ${String(exit.code)}` : 'the stream ended without a completed turn'];
  else if (exit.code !== 0 && exit.code !== null) [status, reason] = ['failed', `codex exec exited with code ${String(exit.code)} after the turn`];
  else [status, reason] = ['completed', 'success'];
  return {
    status,
    reason,
    sessionId,
    requestedModel: input.model,
    actualModel: null,
    costUsd: null,
    usage,
    turns: steps.size,
    durationMs,
    resultText,
    sandbox,
    events,
    authMode: input.auth ?? 'unknown',
    effort,
    initCheck: initCheck as InitCheck | null,
    modelSignal: signal,
    ...(status === 'model-unavailable' && unavailable !== null ? { modelUnavailable: unavailable } : {}),
    ...(limit === null ? {} : { accessSignal: limit.accessSignal, accessLimit: limit.accessLimit, ...(limit.resetAt === undefined ? {} : { resetAt: limit.resetAt }) }),
  };
}

/** A WorkerPort for D's `runLeasedTask` (structurally `{ run(WorkerRunInput) }`). */
export function codexWorkerPort(options: Pick<CodexWorkerInput, 'command' | 'env'> & { readonly evidence?: WorkerEvidenceOptions | false } = {}): { run(input: Omit<CodexWorkerInput, 'command' | 'env'>): Promise<CodexWorkerOutcome> } {
  const { evidence: _evidence, ...binary } = options;
  const evidence = portEvidence('codex', options);
  // A run on the harness's own binary adds its first-use check to the live evidence (worker.route),
  // and gets the found-gone signals its capture certified for that version.
  return { run: withWorkerEvidence('codex', withCertifiedSignals('codex', (input: Omit<CodexWorkerInput, 'command' | 'env'>) => runCodexWorker({ ...input, ...binary }), evidence), evidence) };
}
