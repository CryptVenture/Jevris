/**
 * The Antigravity owned session (ORC-05; owner directive 2026-09-26): a worker port for D's
 * `runLeasedTask` on the Antigravity CLI's headless mode (agy 1.2.11, `agy --help` on this Mac;
 * antigravity.google/docs/cli/headless, checked 2026-09-26). It is the CLI only: it never
 * opens the Antigravity app.
 *
 * One run is `agy --input-format stream-json --output-format stream-json`, with one user event on
 * stdin (`{"event":"user","message":{"content":…}}`), never argv. The CLI emits `init`,
 * `step_update` and one `result` event per turn, then exits when stdin has ended.
 *
 * - The model is `--model`. A registry model goes as its Antigravity slug, which names the
 *   effort (`gemini-3.8-flash-low`; routing design R6, R18), so no `--effort` goes with it. An
 *   id the registry does not know keeps `--effort` (low, medium, high or max; C's xhigh passes
 *   as high). `--sandbox` turns the terminal restrictions on, and
 *   `--print-timeout` matches the port's wall clock.
 * - Least privilege is weaker here than in the other ports, and the outcome says so.
 *   Antigravity's tool pre-approval lives only in `~/.gemini/antigravity-cli/settings.json`,
 *   which Jevris never writes. Headless, reads and writes inside the workspace are auto-allowed
 *   and shell commands are soft-denied unless that file allows them. So the port can
 *   only watch: the `init` event must show `permission_mode` "request-review" (never
 *   "always-proceed") and a cwd that is the worktree, or the run is killed and refused. A tool
 *   step outside the grant (a write when only reads were granted, a shell command without Bash,
 *   any web tool) kills the run and refuses it. That enforcement is after the fact: the step
 *   has started when the port sees it. `readOnlyEnforcement` says `after-the-fact` whenever
 *   the grant has no write tool.
 * - Jevris never passes `--dangerously-skip-permissions`.
 *
 * Auth: Antigravity signs in with a Google account (the subscription path). Its headless docs
 * name no API-key sign-in, so `api-key` is refused rather than guessed. A subscription run
 * sees no vendor or Google key.
 *
 * Access limits (R67, design 5.2): a run with no successful result whose `error`, else the last
 * 4 KiB of stderr of a failed run, matches a pinned G pattern (a quota or usage limit reached, a
 * weekly limit) is `access-limit`, with the pattern id and the stated reset, and a fixed reason
 * naming the class; it is not the task's failure. Every G row needs a certified binary, so until a
 * capture certifies one the reset is the rule's. Only the timed usage-window class exists here.
 *
 * Cost: the CLI reports tokens, not money, so `costUsd` stays null. `thinking_tokens` are
 * reported apart from `output_tokens`, so the port adds them into `outputTokens`.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AccessLimitFinding, AccessSignalWire, ModelRegistry } from '@jevris/contracts';
import { portAccess, textAccessSignal } from './access-signal.js';
import { VENDOR_KEYS, type AuthMode } from './harness-auth.js';
import { harnessModelChoice, type HarnessModelChoice } from './harness-model.js';
import { count, initFailed, INIT_OK, interruptedStatus, jsonLine, OWNED_WRITE_TOOLS, rec, runStreamingSession, sessionIdReporter, validateOwnedInput, type InitCheck, type OwnedUsage, type OwnedWorkerInputBase, type OwnedWorkerStatus, type WorkerEffort } from './owned-session.js';
import { antigravityModelSignal, eventShape, modelUnavailableOf, modelUnavailableText, withCertifiedSignals, type ModelSignal, type ModelUnavailable } from './model-signals.js';
import { portEvidence, withWorkerEvidence, type WorkerEvidenceOptions } from './worker-evidence.js';

export const ANTIGRAVITY_BINARY = 'agy';
export const ANTIGRAVITY_MISSING_MESSAGE = 'unsupported: install the Antigravity CLI (agy), sign in, and run jevris install --harness antigravity';
/** `agy --effort` levels (agy 1.2.11 help). */
export const ANTIGRAVITY_EFFORTS: readonly WorkerEffort[] = ['low', 'medium', 'high', 'max'];
/** Google key variables a subscription run must not see, beside VENDOR_KEYS. */
const GOOGLE_KEYS: readonly string[] = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];
const MAX_RESULT_TEXT = 8_000;
/** A result status a reason may carry (`FAILED`, `CANCELLED`): upper case and underscores, never free text. */
const RUN_STATUS = /^[A-Z][A-Z_]{0,31}$/;

export type AntigravityWorkerStatus = OwnedWorkerStatus;

export interface AntigravityWorkerInput extends OwnedWorkerInputBase {
  /** Receives each event's name (and step type), never content. */
  readonly onEvent?: (event: { readonly type: string; readonly stepType?: string }) => void;
}

export interface AntigravityWorkerOutcome {
  readonly status: AntigravityWorkerStatus;
  readonly reason: string;
  /** The conversation id. */
  readonly sessionId: string | null;
  readonly requestedModel: string;
  /** The model the init event names, or null. */
  readonly actualModel: string | null;
  /** The CLI reports no cost: always null. */
  readonly costUsd: number | null;
  readonly usage: OwnedUsage | null;
  readonly turns: number | null;
  readonly durationMs: number;
  readonly resultText: string | null;
  readonly authMode: AuthMode | 'unknown';
  readonly events: number;
  readonly effort: WorkerEffort | null;
  /** How a grant without write tools is enforced: never before a step, only by killing the run. */
  readonly readOnlyEnforcement: 'after-the-fact' | 'not-applicable';
  /** The first-use check on the init event: request-review mode, the worktree as cwd, the model asked for. */
  readonly initCheck: InitCheck | null;
  /** The found-gone signal an ERROR result showed (model-signals.ts); C's table gives it no reason until a capture. */
  readonly modelSignal: ModelSignal | null;
  /** For `model-unavailable`: C's reason, the port and the auth mode, for D to record. */
  readonly modelUnavailable?: ModelUnavailable;
  /** For `access-limit`: when the limit lifts (ISO), when the text states a reset core accepts. */
  readonly resetAt?: string;
  /** For `access-limit` (R67): the pinned pattern the error text matched, never the text. */
  readonly accessSignal?: AccessSignalWire;
  /** This port's own classification of `accessSignal`: its claim, never recorded as such. */
  readonly accessLimit?: AccessLimitFinding;
}

/**
 * How Antigravity runs `model` at C's `effort` (routing design R6, R18; harness-model.ts): a
 * registry model as its Antigravity slug, the effort in the slug (`gemini-3.8-flash-low`); a
 * pinned slug as given. An id the registry does not know runs as given with `--effort`; a registry
 * model Antigravity names no slug for (another provider's) is null.
 */
export function antigravityModelChoice(model: string, effort?: WorkerEffort, registry?: ModelRegistry): HarnessModelChoice | null {
  return harnessModelChoice('antigravity', model, effort, { ...(registry === undefined ? {} : { registry }), fallbackLevels: ANTIGRAVITY_EFFORTS, unregistered: (id) => id });
}

/** The exact argv (the prompt goes on stdin as one user event, never argv). */
export function antigravityArgs(model: string, timeoutMs: number, effort: WorkerEffort | null): readonly string[] {
  return [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    model,
    '--sandbox',
    '--print-timeout',
    `${String(Math.ceil(timeoutMs / 1000))}s`,
    ...(effort === null ? [] : ['--effort', effort]),
  ];
}

/** The one stdin line: a user event carrying the prompt. */
export function antigravityInput(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

/** What a tool step does, from its name: a web call, a shell command, a write, or other (reads, MCP). */
export function antigravityToolKind(name: string): 'web' | 'command' | 'write' | 'other' {
  if (/web|fetch|url|browser|http/i.test(name)) return 'web';
  if (/command|shell|terminal|bash|exec|run_/i.test(name)) return 'command';
  if (/write|edit|replace|create|delete|remove|move|rename|patch|apply|mkdir/i.test(name)) return 'write';
  return 'other';
}

/** Why a tool step is outside the grant, or null. */
export function antigravityToolRefusal(name: string, allowedTools: readonly string[]): string | null {
  const kind = antigravityToolKind(name);
  if (kind === 'web') return `the web tool ${name} is never granted to an owned worker`;
  if (kind === 'command' && !allowedTools.includes('Bash')) return `the shell tool ${name} was not granted (no Bash)`;
  if (kind === 'write' && !allowedTools.some((tool) => OWNED_WRITE_TOOLS.has(tool))) return `the write tool ${name} was not granted (a read-only grant)`;
  return null;
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function refusedOutcome(input: Pick<AntigravityWorkerInput, 'model' | 'allowedTools'>, status: AntigravityWorkerStatus, reason: string): AntigravityWorkerOutcome {
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
    authMode: 'unknown',
    events: 0,
    effort: null,
    readOnlyEnforcement: enforcement(input.allowedTools),
    initCheck: null,
    modelSignal: null,
  };
}

function enforcement(allowedTools: readonly string[] | undefined): 'after-the-fact' | 'not-applicable' {
  return Array.isArray(allowedTools) && allowedTools.some((tool) => OWNED_WRITE_TOOLS.has(tool)) ? 'not-applicable' : 'after-the-fact';
}

export async function runAntigravityWorker(input: AntigravityWorkerInput): Promise<AntigravityWorkerOutcome> {
  const invalid = validateOwnedInput(input);
  if (invalid !== null) return refusedOutcome(input, 'refused', `invalid ${invalid}`);
  if (input.signal?.aborted === true) return refusedOutcome(input, 'aborted', 'aborted before start');
  if (input.auth === 'api-key') return refusedOutcome(input, 'refused', 'refused: the Antigravity CLI documents no API-key sign-in; state subscription (a Google sign-in) for antigravity');
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(input.env ?? process.env)) if (typeof value === 'string') env[key] = value;
  if (input.auth === 'subscription') for (const key of [...VENDOR_KEYS, ...GOOGLE_KEYS]) delete env[key];
  const choice = antigravityModelChoice(input.model, input.effort, input.registry);
  if (choice === null) return refusedOutcome(input, 'refused', `refused: Antigravity names no model for ${input.model}; it serves Google models`);
  const effort = choice.level;
  const harnessModel = choice.id;
  const file = input.command?.file ?? ANTIGRAVITY_BINARY;
  // A registry model carries its effort in the slug (`gemini-3.8-flash-low`), so no --effort goes with it.
  const args = [...(input.command?.args ?? []), ...antigravityArgs(harnessModel, input.timeoutMs, choice.effortInModel ? null : (choice.effortToken as WorkerEffort | null))];
  const worktree = realOrResolved(input.cwd);

  let sessionId: string | null = null;
  const reportSession = sessionIdReporter(input.onSessionId);
  let actualModel: string | null = null;
  let result: { readonly [key: string]: unknown } | undefined;
  let refusal: string | null = null;
  let stepCapHit = false;
  let events = 0;
  const toolSteps = new Set<string>();
  let initCheck: InitCheck | null = null;

  const onLine = (line: string, stop: () => void): void => {
    const event = jsonLine(line);
    if (event === undefined || typeof event['event'] !== 'string') return;
    events += 1;
    const type = event['event'] as string;
    const refuse = (why: string): void => {
      if (refusal !== null) return;
      refusal = `refused: ${why}`;
      stop();
    };
    if (type === 'init') {
      if (typeof event['conversation_id'] === 'string') sessionId ??= (event['conversation_id'] as string).slice(0, 128);
      reportSession(sessionId);
      const init = rec(event['init']);
      input.onEvent?.({ type });
      if (typeof init?.['model'] === 'string' && init['model'] !== '') actualModel = (init['model'] as string).slice(0, 128);
      if (init?.['permission_mode'] !== 'request-review') {
        initCheck ??= initFailed('WORKER_INIT_BYPASS');
        refuse(`the session started with permission_mode ${String(init?.['permission_mode'] ?? 'unknown')}, not request-review`);
      } else if (typeof init['cwd'] !== 'string' || realOrResolved(init['cwd'] as string) !== worktree) {
        initCheck ??= initFailed('WORKER_INIT_CWD');
        refuse('the session did not start in the task worktree');
      } else if (typeof init['model'] === 'string' && init['model'] !== '' && !(init['model'] as string).toLowerCase().includes(harnessModel.toLowerCase()) && !harnessModel.toLowerCase().includes((init['model'] as string).toLowerCase())) {
        initCheck ??= initFailed('WORKER_INIT_MODEL');
        refuse(`the session started on ${init['model'] as string}, not ${harnessModel}`);
      } else initCheck ??= INIT_OK;
    } else if (type === 'step_update') {
      const step = rec(event['step_update']);
      const stepType = typeof step?.['step_type'] === 'string' ? (step['step_type'] as string) : undefined;
      input.onEvent?.(stepType === undefined ? { type } : { type, stepType });
      if (sessionId === null && typeof step?.['conversation_id'] === 'string') sessionId = (step['conversation_id'] as string).slice(0, 128);
      reportSession(sessionId);
      if (stepType === 'tool') {
        const name = typeof step?.['tool_name'] === 'string' ? (step['tool_name'] as string) : typeof rec(step?.['tool_info'])?.['name'] === 'string' ? (rec(step?.['tool_info'])?.['name'] as string) : '';
        const why = name === '' ? null : antigravityToolRefusal(name, input.allowedTools);
        if (why !== null) refuse(why);
        const id = typeof step?.['step_index'] === 'number' ? String(step['step_index']) : null;
        if (id !== null && !toolSteps.has(id)) {
          toolSteps.add(id);
          if (toolSteps.size > input.maxTurns && !stepCapHit) {
            stepCapHit = true;
            stop();
          }
        }
      }
    } else if (type === 'result') {
      input.onEvent?.({ type });
      result = rec(event['result']);
      if (sessionId === null && typeof result?.['conversation_id'] === 'string') sessionId = (result['conversation_id'] as string).slice(0, 128);
    }
  };

  const end = await runStreamingSession({ file, args, cwd: input.cwd, env, input: antigravityInput(input.prompt), timeoutMs: input.timeoutMs, ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.onStart === undefined ? {} : { onStart: input.onStart }), sessionId: () => sessionId, onLine });
  const { exit, stderr, durationMs } = end;
  if (!exit.spawned) return { ...refusedOutcome(input, 'unsupported', ANTIGRAVITY_MISSING_MESSAGE), durationMs };

  const final = result as { readonly [key: string]: unknown } | undefined;
  const refused = refusal as string | null;
  const runStatus = typeof final?.['status'] === 'string' ? (final['status'] as string) : null;
  const errorText = typeof final?.['error'] === 'string' ? (final['error'] as string) : '';
  const response = typeof final?.['response'] === 'string' ? (final['response'] as string) : null;
  const usage = rec(final?.['usage']);

  const signalId = final !== undefined && runStatus !== 'SUCCESS' ? antigravityModelSignal(`${errorText}\n${stderr}`) : null;
  const signal: ModelSignal | null = signalId === null ? null : { id: signalId, channel: 'event', shape: eventShape({ event: 'result', result: final }) };
  const unavailable = modelUnavailableOf('antigravity', signal, input.certifiedModelSignals, input.auth ?? 'unknown');
  let status: AntigravityWorkerStatus;
  let reason: string;
  const interrupted = interruptedStatus(end, input.timeoutMs);
  // Success wins (design 5.5): only a run with no successful result, not stopped by Jevris, reports
  // an access signal; the result's error first, else stderr of a run that exited non-zero.
  const ended = refused === null && interrupted === null && !stepCapHit && runStatus !== 'SUCCESS';
  const failedExit = exit.code !== 0 && exit.code !== null;
  const nowMs = Date.now();
  const candidate = !ended ? null : (textAccessSignal('antigravity', errorText, nowMs) ?? (final === undefined || failedExit ? textAccessSignal('antigravity', stderr, nowMs) : null));
  const access = candidate === null ? null : portAccess(candidate, input.auth ?? 'unknown', nowMs);
  if (refused !== null) [status, reason] = ['refused', refused];
  else if (interrupted !== null) [status, reason] = interrupted;
  else if (stepCapHit) [status, reason] = ['max-turns', `more than ${String(input.maxTurns)} steps`];
  // R80: the error text and stderr (remote text) never enter a reason.
  else if (access !== null) [status, reason] = [access.status, access.reason];
  else if (final === undefined) [status, reason] = ['failed', exit.code !== 0 ? `agy exited with code ${String(exit.code)}` : 'the stream ended without a result'];
  else if (runStatus === 'SUCCESS') [status, reason] = ['completed', 'success'];
  else if (unavailable !== null) [status, reason] = ['model-unavailable', modelUnavailableText(input.model, unavailable)];
  else [status, reason] = ['failed', runStatus !== null && RUN_STATUS.test(runStatus) ? `the run ended ${runStatus}` : 'the run ended without a known status'];

  return {
    status,
    reason,
    sessionId,
    requestedModel: input.model,
    actualModel,
    costUsd: null,
    usage:
      usage === undefined
        ? null
        : {
            inputTokens: count(usage['input_tokens']),
            outputTokens: count(usage['output_tokens']) + count(usage['thinking_tokens']),
            cacheReadInputTokens: count(usage['cache_read_tokens']),
            cacheCreationInputTokens: 0,
          },
    turns: typeof final?.['num_turns'] === 'number' ? count(final['num_turns']) : toolSteps.size,
    durationMs,
    resultText: status === 'completed' && response !== null ? response.slice(0, MAX_RESULT_TEXT) : null,
    authMode: input.auth ?? 'unknown',
    events,
    effort,
    readOnlyEnforcement: enforcement(input.allowedTools),
    initCheck: initCheck as InitCheck | null,
    modelSignal: signal,
    ...(status === 'model-unavailable' && unavailable !== null ? { modelUnavailable: unavailable } : {}),
    ...(access === null ? {} : { accessSignal: access.accessSignal, accessLimit: access.accessLimit, ...(access.resetAt === undefined ? {} : { resetAt: access.resetAt }) }),
  };
}

/** A WorkerPort for D's `runLeasedTask` (structurally `{ run(WorkerRunInput) }`). */
export function antigravityWorkerPort(options: Pick<AntigravityWorkerInput, 'command' | 'env'> & { readonly evidence?: WorkerEvidenceOptions | false } = {}): { run(input: Omit<AntigravityWorkerInput, 'command' | 'env'>): Promise<AntigravityWorkerOutcome> } {
  const { evidence: _evidence, ...binary } = options;
  const evidence = portEvidence('antigravity', options);
  // A run on the harness's own binary adds its first-use check to the live evidence (worker.route),
  // and gets the found-gone signals its capture certified for that version.
  return { run: withWorkerEvidence('antigravity', withCertifiedSignals('antigravity', (input: Omit<AntigravityWorkerInput, 'command' | 'env'>) => runAntigravityWorker({ ...input, ...binary }), evidence), evidence) };
}
