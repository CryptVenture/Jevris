/**
 * The Claude Code owned session through the user's installed CLI (ORC-05, owner decision
 * 2026-09-26): a worker port for D's `runLeasedTask`, beside the Agent SDK port and the Codex
 * port. It is the path for a subscription login (the Agent SDK never runs on a claude.ai login),
 * and it also runs with an API key.
 *
 * One run is one `claude -p` turn in stream-json: the prompt on stdin, never argv. It uses the
 * user's installed Claude Code and its config, so the installed Jevris plugin's hooks run in
 * the session too.
 *
 * - The model is chosen at start (`--model`); an active turn is never re-steered.
 * - `--max-turns` and `--max-budget-usd` bound the run, and Claude Code reports which one ended
 *   it. Cancellation (the caller's AbortSignal) and the wall-clock timeout kill the whole
 *   process tree.
 * - Native permissions stay authoritative. Only the granted tools are pre-approved
 *   (`--allowedTools`); anything else would need a prompt, which a print run cannot show, so it
 *   is refused. Web tools are disallowed, and `--strict-mcp-config` with no `--mcp-config` loads
 *   no MCP server. Jevris never passes `--dangerously-skip-permissions` or a bypass mode.
 * - Auth: `auth: 'subscription'` removes every vendor key from the child's environment (it keeps
 *   CLAUDE_CODE_OAUTH_TOKEN); `auth: 'api-key'` needs ANTHROPIC_API_KEY and removes the
 *   subscription token. The session's init event says which source it actually used
 *   (`apiKeySource`); a run whose source contradicts the decided mode is stopped at once and
 *   refused, before any model call is billed the wrong way.
 * - Access limits (R63, design 5.2): a run with no successful result that ended on a `rejected`
 *   rate-limit event, an `api_retry` or assistant error enum, or an `is_error` result matching a
 *   pinned C pattern is `access-limit` (or `overloaded`), with an access signal of codes and a
 *   pattern id only, and a fixed reason naming the class: it is not the task's failure. A run
 *   through a redirected endpoint (a base-URL override or a cloud-provider switch, or a
 *   workspace `apiKeyHelper`) reports none (OP-12).
 * - Cost: `total_cost_usd` is the provider's number for an API key. On a subscription it is only
 *   an API-equivalent estimate, so `costUsd` is null there (usage limits, not dollars).
 */
import { workerEnv, type AuthMode } from './harness-auth.js';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeManagedSettingsPaths } from './managed-policy.js';
import type { AccessLimitFinding, AccessSignalWire } from '@jevris/contracts';
import { claudeAccessSignal, claudeStreamAccess, noteClaudeAccess, portAccess } from './access-signal.js';
export { claudeAccessSignal, claudeStreamAccess, claudeTranscriptAccess, noteClaudeAccess, type ClaudeStreamAccess } from './access-signal.js';
import { count, initFailed, INIT_OK, interruptedStatus, jsonLine, sameDirectory, nearestEffort, OWNED_GRANTABLE_TOOLS, rec, runStreamingSession, sessionIdReporter, validateOwnedInput, type InitCheck, type OwnedWorkerInputBase, type OwnedWorkerStatus, type WorkerEffort } from './owned-session.js';
import { claudeModelSignal, eventShape, modelUnavailableOf, modelUnavailableText, withCertifiedSignals, type ModelSignal, type ModelUnavailable } from './model-signals.js';
import { portEvidence, withWorkerEvidence, type WorkerEvidenceOptions } from './worker-evidence.js';

export const CLAUDE_BINARY = 'claude';
export const CLAUDE_MISSING_MESSAGE = 'unsupported: install Claude Code (claude), log in, and run jevris install --harness claude';

/** The tool names D grants owned workers. */
export const CLAUDE_GRANTABLE_TOOLS: readonly string[] = OWNED_GRANTABLE_TOOLS;
/** Claude Code's `--effort` levels (code.claude.com/docs/en/model-config, checked 2026-09-26). */
export const CLAUDE_EFFORTS: readonly WorkerEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Never available to an owned worker: no web access. */
export const CLAUDE_DISALLOWED_TOOLS: readonly string[] = ['WebFetch', 'WebSearch'];
const MAX_RESULT_TEXT = 8_000;
/** A harness code a reason may carry (a result subtype): lower case, digits and underscores, never free text. */
const REASON_TOKEN = /^[a-z][a-z0-9_]{0,39}$/;
/** `apiKeySource` values that mean a subscription login (claude.ai or CLAUDE_CODE_OAUTH_TOKEN). */
const SUBSCRIPTION_SOURCES = new Set(['none', 'oauth']);

export type ClaudeWorkerStatus = OwnedWorkerStatus;

export interface ClaudeWorkerInput extends OwnedWorkerInputBase {
  /** Receives each event's type (and subtype), never content. */
  readonly onEvent?: (event: { readonly type: string; readonly subtype?: string }) => void;
}

export interface ClaudeWorkerOutcome {
  readonly status: ClaudeWorkerStatus;
  readonly reason: string;
  readonly sessionId: string | null;
  readonly requestedModel: string;
  /** The model that answered (from the assistant messages), or null when none did. */
  readonly actualModel: string | null;
  /** Provider-reported dollars with an API key; null on a subscription (an estimate only). */
  readonly costUsd: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadInputTokens: number; readonly cacheCreationInputTokens: number } | null;
  readonly turns: number | null;
  readonly durationMs: number;
  readonly resultText: string | null;
  /** The auth the session actually used, from its init event; 'unknown' before one arrives. */
  readonly authMode: AuthMode | 'unknown';
  /** For `access-limit`: when the limit lifts (ISO), when Claude Code says. */
  readonly resetAt?: string;
  /**
   * For `access-limit` and `overloaded` (R63): the signal the run ended on, in E's wire shape
   * (codes, a reset and a pattern id; never text). The runner classifies it again (R70).
   */
  readonly accessSignal?: AccessSignalWire;
  /** This port's own classification of `accessSignal`: its claim, never recorded as such. */
  readonly accessLimit?: AccessLimitFinding;
  readonly events: number;
  /** The `--effort` level passed, or null (none asked, or a model without effort levels). */
  readonly effort: WorkerEffort | null;
  /**
   * The first-use check on the init event, before any tool runs: the session's cwd is the
   * worktree, its permission mode is not a bypass, no web tool is loaded, the model is the one
   * asked for, and the auth source is the decided mode. Effort is not in the init event
   * (Claude Code docs, 2026-09-26): only the argv carries it.
   */
  readonly initCheck: InitCheck | null;
  /** The found-gone signal the result showed (model-signals.ts), recorded or not; null when none. */
  readonly modelSignal: ModelSignal | null;
  /** For `model-unavailable`: C's reason, the port and the auth mode, for D to record. */
  readonly modelUnavailable?: ModelUnavailable;
}

export function validateClaudeWorkerInput(input: ClaudeWorkerInput): string | null {
  return validateOwnedInput(input);
}

/**
 * The `--effort` level for a model, or null. Haiku models have no effort levels, so nothing is
 * passed for them (the run keeps the model's default and records effort as null).
 */
export function claudeEffort(model: string, effort: WorkerEffort | undefined): WorkerEffort | null {
  if (/haiku/i.test(model)) return null;
  return nearestEffort(effort, CLAUDE_EFFORTS);
}

/** The exact `claude` argv for one owned turn (the prompt goes on stdin, never argv). */
export function claudePrintArgs(input: Pick<ClaudeWorkerInput, 'model' | 'maxTurns' | 'maxBudgetUsd' | 'allowedTools' | 'effort'>): readonly string[] {
  const effort = claudeEffort(input.model, input.effort);
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    input.model,
    '--max-turns',
    String(input.maxTurns),
    '--max-budget-usd',
    String(input.maxBudgetUsd),
    '--allowedTools',
    input.allowedTools.join(','),
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS.join(','),
    '--strict-mcp-config',
    // Session-only in -p mode; never CLAUDE_CODE_EFFORT_LEVEL, which overrides settings process-wide.
    ...(effort === null ? [] : ['--effort', effort]),
  ];
}

/** The auth mode an init event's `apiKeySource` means. */
export function authFromApiKeySource(source: unknown): AuthMode | 'unknown' {
  if (typeof source !== 'string') return 'unknown';
  return SUBSCRIPTION_SOURCES.has(source) ? 'subscription' : 'api-key';
}

function refusedOutcome(input: Pick<ClaudeWorkerInput, 'model'>, status: ClaudeWorkerStatus, reason: string): ClaudeWorkerOutcome {
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
    initCheck: null,
    modelSignal: null,
  };
}

/**
 * Variables that send Claude Code to another party or endpoint than Anthropic's API (OP-12;
 * Claude Code's environment-variable reference, read 2026-09-28): any `ANTHROPIC_*BASE_URL`, a
 * Bedrock, Vertex, Foundry, Mantle or AWS provider switch, and the Foundry resource and AWS
 * workspace that select one. The hook launcher's guard uses the same list (B's LOW 28).
 */
const REDIRECT_VAR = /^(?:ANTHROPIC_(?:[A-Z0-9]+_)*BASE_URL|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY|MANTLE|AWS)[A-Z0-9_]*|ANTHROPIC_FOUNDRY_RESOURCE|ANTHROPIC_AWS_WORKSPACE_ID)$/;
const SETTINGS_CAP = 262_144;

/**
 * The settings files whose `env` and `apiKeyHelper` Claude Code applies to a run in `cwd`: the
 * workspace's `.claude/settings.json` and `settings.local.json`, the user's `settings.json` (in
 * CLAUDE_CONFIG_DIR, else `<HOME>/.claude`), and the OS's managed settings. The hook's guard sees
 * the user and managed `env` because Claude Code puts it in the hook's environment; the owned
 * worker reads the files instead, so both paths agree (B's LOW 39).
 */
export function claudeSettingsFiles(cwd: string, env: { readonly [key: string]: string | undefined }, platform: string = process.platform): readonly string[] {
  const files = [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
  const configDir = env['CLAUDE_CONFIG_DIR'] ?? '';
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '';
  if (configDir !== '') files.push(join(configDir, 'settings.json'));
  else if (home !== '') files.push(join(home, '.claude', 'settings.json'));
  files.push(...claudeManagedSettingsPaths(platform, env));
  return files;
}

/**
 * Whether the run's provider endpoint is not Anthropic's own (design 5.5 guard 6, OP-12): the
 * child's environment names another endpoint, or a settings file Claude Code applies to the run
 * (claudeSettingsFiles) sets one in `env` or supplies a key through `apiKeyHelper`. An access
 * signal from such a run names no known party, so the port reports none. A settings file that
 * cannot be read as a small regular JSON file counts as redirected.
 */
export async function claudeEndpointRedirected(cwd: string, env: { readonly [key: string]: string | undefined }, platform: string = process.platform): Promise<boolean> {
  if (Object.keys(env).some((name) => REDIRECT_VAR.test(name) && (env[name] ?? '') !== '')) return true;
  for (const file of claudeSettingsFiles(cwd, env, platform)) {
    const info = await lstat(file).catch(() => null);
    if (info === null) continue;
    if (!info.isFile() || info.size > SETTINGS_CAP) return true;
    const parsed = await readFile(file, 'utf8').then((raw) => JSON.parse(raw) as unknown).catch(() => undefined);
    const settings = rec(parsed);
    if (settings === undefined) return true;
    if (settings['apiKeyHelper'] !== undefined) return true;
    const vars = rec(settings['env']);
    if (vars !== undefined && Object.keys(vars).some((key) => REDIRECT_VAR.test(key) && vars[key] !== undefined && vars[key] !== '')) return true;
  }
  return false;
}

/** The model the init event names is the one asked for (an alias or a dated id both match). */
export function sameClaudeModel(requested: string, reported: string): boolean {
  const norm = (model: string): string => model.toLowerCase().replace(/\[[^\]]*\]/g, '');
  const a = norm(requested);
  const b = norm(reported);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

/** The first-use check on a `system/init` event (see ClaudeWorkerOutcome.initCheck). */
export function claudeInitCheck(event: { readonly [key: string]: unknown }, input: Pick<ClaudeWorkerInput, 'cwd' | 'model' | 'auth'>): InitCheck {
  const cwd = event['cwd'];
  if (typeof cwd !== 'string' || !sameDirectory(cwd, input.cwd)) return initFailed('WORKER_INIT_CWD');
  if (event['permissionMode'] === 'bypassPermissions') return initFailed('WORKER_INIT_BYPASS');
  const tools = Array.isArray(event['tools']) ? (event['tools'] as unknown[]) : [];
  if (tools.some((tool) => typeof tool === 'string' && CLAUDE_DISALLOWED_TOOLS.includes(tool))) return initFailed('WORKER_INIT_TOOLS');
  if (typeof event['model'] === 'string' && !sameClaudeModel(input.model, event['model'] as string)) return initFailed('WORKER_INIT_MODEL');
  const auth = authFromApiKeySource(event['apiKeySource']);
  if (input.auth !== undefined && auth !== 'unknown' && auth !== input.auth) return initFailed('WORKER_INIT_AUTH');
  return INIT_OK;
}

export async function runClaudeWorker(input: ClaudeWorkerInput): Promise<ClaudeWorkerOutcome> {
  const invalid = validateClaudeWorkerInput(input);
  if (invalid !== null) return refusedOutcome(input, 'refused', `invalid ${invalid}`);
  if (input.signal?.aborted === true) return refusedOutcome(input, 'aborted', 'aborted before start');
  const env = workerEnv('claude', input.auth, input.env ?? process.env);
  if (input.auth === 'api-key' && (env['ANTHROPIC_API_KEY'] ?? '') === '') return refusedOutcome(input, 'refused', 'refused: api-key mode needs ANTHROPIC_API_KEY in the environment');
  const file = input.command?.file ?? CLAUDE_BINARY;
  const args = [...(input.command?.args ?? []), ...claudePrintArgs(input)];

  let sessionId: string | null = null;
  const reportSession = sessionIdReporter(input.onSessionId);
  let authMode = 'unknown' as AuthMode | 'unknown';
  let mismatch = null as string | null;
  let actualModel: string | null = null;
  let result: { readonly [key: string]: unknown } | undefined;
  const seen = claudeStreamAccess();
  let events = 0;
  let initCheck: InitCheck | null = null;

  const onLine = (line: string, stop: () => void): void => {
    const event = jsonLine(line); // Not an event: ignored, never fatal.
    if (event === undefined || typeof event['type'] !== 'string') return;
    events += 1;
    const type = event['type'] as string;
    const subtype = typeof event['subtype'] === 'string' ? (event['subtype'] as string) : undefined;
    input.onEvent?.(subtype === undefined ? { type } : { type, subtype });
    if (sessionId === null && typeof event['session_id'] === 'string') sessionId = (event['session_id'] as string).slice(0, 128);
    reportSession(sessionId);
    if (type === 'system' && subtype === 'init') {
      authMode = authFromApiKeySource(event['apiKeySource']);
      initCheck ??= claudeInitCheck(event, input);
      if (!initCheck.ok && mismatch === null) {
        mismatch =
          initCheck.reasonCode === 'WORKER_INIT_AUTH'
            ? `refused: the session used ${authMode === 'api-key' ? 'an API key' : 'a subscription login'} but ${input.auth ?? 'another mode'} was decided`
            : `refused: the session's init failed the first-use check (${initCheck.reasonCode ?? ''})`;
        stop();
      }
    } else if (type === 'assistant') {
      const message = rec(event['message']);
      if (typeof message?.['model'] === 'string' && message['model'] !== '<synthetic>') actualModel = (message['model'] as string).slice(0, 128);
      noteClaudeAccess(event, type, subtype, seen);
    } else if (type === 'result') {
      result = event;
    } else noteClaudeAccess(event, type, subtype, seen);
  };

  const end = await runStreamingSession({ file, args, cwd: input.cwd, env, input: input.prompt, timeoutMs: input.timeoutMs, ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.onStart === undefined ? {} : { onStart: input.onStart }), sessionId: () => sessionId, onLine });
  const { exit, stderr, durationMs } = end;
  const interrupted = interruptedStatus(end, input.timeoutMs);
  if (!exit.spawned) return { ...refusedOutcome(input, 'unsupported', CLAUDE_MISSING_MESSAGE), durationMs };

  const usage = rec(result?.['usage']);
  const subtype = typeof result?.['subtype'] === 'string' ? (result['subtype'] as string) : null;
  const isError = result?.['is_error'] === true;
  const text = typeof result?.['result'] === 'string' ? (result['result'] as string) : null;
  // Success wins (design 5.5): only a run with no successful result, not stopped by Jevris, and
  // not through a redirected endpoint, reports an access signal.
  const ended = mismatch === null && interrupted === null && (result === undefined || isError);
  const access = ended && !(await claudeEndpointRedirected(input.cwd, env)) ? portAccess(claudeAccessSignal(seen, isError ? text : null, Date.now()), authMode, Date.now()) : null;
  const signalId = result === undefined ? null : claudeModelSignal(isError, text);
  const modelSignal: ModelSignal | null = signalId === null ? null : { id: signalId, channel: 'event', shape: eventShape(result) };
  const unavailable = modelUnavailableOf('claude', modelSignal, input.certifiedModelSignals, authMode);

  let status: ClaudeWorkerStatus;
  let reason: string;
  if (mismatch !== null) [status, reason] = ['refused', mismatch];
  else if (interrupted !== null) [status, reason] = interrupted;
  else if (access !== null) [status, reason] = [access.status, access.reason];
  else if (unavailable !== null) [status, reason] = ['model-unavailable', modelUnavailableText(input.model, unavailable)];
  else if (subtype === 'error_max_turns') [status, reason] = ['max-turns', `more than ${String(input.maxTurns)} turns`];
  else if (subtype === 'error_max_budget_usd') [status, reason] = ['budget-exceeded', `over ${String(input.maxBudgetUsd)} USD`];
  // R80: a reason is fixed text plus a code; the result text and stderr (remote text) never enter it.
  else if (result === undefined) [status, reason] = ['failed', exit.code !== 0 ? `claude exited with code ${String(exit.code)}` : 'the stream ended without a result'];
  else if (isError || subtype !== 'success') [status, reason] = ['failed', `the turn ended with an error${subtype !== null && subtype !== 'success' && REASON_TOKEN.test(subtype) ? ` (${subtype})` : ''}`];
  else [status, reason] = ['completed', 'success'];

  const cost = typeof result?.['total_cost_usd'] === 'number' && Number.isFinite(result['total_cost_usd']) ? (result['total_cost_usd'] as number) : null;
  return {
    status,
    reason,
    sessionId,
    requestedModel: input.model,
    actualModel,
    costUsd: authMode === 'api-key' ? cost : null,
    usage:
      usage === undefined
        ? null
        : {
            inputTokens: count(usage['input_tokens']),
            outputTokens: count(usage['output_tokens']),
            cacheReadInputTokens: count(usage['cache_read_input_tokens']),
            cacheCreationInputTokens: count(usage['cache_creation_input_tokens']),
          },
    turns: typeof result?.['num_turns'] === 'number' ? count(result['num_turns']) : null,
    durationMs,
    resultText: status === 'completed' && text !== null ? text.slice(0, MAX_RESULT_TEXT) : null,
    authMode,
    ...(access === null ? {} : { accessSignal: access.accessSignal, accessLimit: access.accessLimit, ...(access.resetAt === undefined ? {} : { resetAt: access.resetAt }) }),
    events,
    effort: claudeEffort(input.model, input.effort),
    initCheck: initCheck as InitCheck | null,
    modelSignal,
    ...(status === 'model-unavailable' && unavailable !== null ? { modelUnavailable: unavailable } : {}),
  };
}

/** A WorkerPort for D's `runLeasedTask` (structurally `{ run(WorkerRunInput) }`). */
export function claudeWorkerPort(options: Pick<ClaudeWorkerInput, 'command' | 'env'> & { readonly evidence?: WorkerEvidenceOptions | false } = {}): { run(input: Omit<ClaudeWorkerInput, 'command' | 'env'>): Promise<ClaudeWorkerOutcome> } {
  const { evidence: _evidence, ...binary } = options;
  const evidence = portEvidence('claude', options);
  // A run on the harness's own binary adds its first-use check to the live evidence (worker.route),
  // and gets the found-gone signals its capture certified for that version.
  return { run: withWorkerEvidence('claude', withCertifiedSignals('claude', (input: Omit<ClaudeWorkerInput, 'command' | 'env'>) => runClaudeWorker({ ...input, ...binary }), evidence), evidence) };
}
