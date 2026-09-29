/**
 * Harness runners for the trial driver (trial-driver.ts).
 *
 * - `sdkRunner`: the primary runner. It runs the task through the Claude Agent SDK with
 *   D's `runOwnedWorker` (@jevris/adapter-claude-sdk), with native permissions on the default
 *   mode. The SDK reports the actual model, usage and total cost, so cost is provider-reported.
 *   It loads no filesystem settings (settingSources: []). A product arm loads the installed
 *   Jevris plugin from the run's profile. The log-reduction component replaces the Bash tool
 *   with one in-process MCP tool whose output goes through the product's distillation.
 * - `cliRunner`: `claude -p`, `kilo run` and `opencode run` in the run's profile, in their
 *   non-interactive JSON output modes. A CLI harness runs its own shell tool, so the
 *   log-reduction component cannot be applied there, and those arms are refused.
 *
 * Both are billed live runs: without an injected seam they need JEVRIS_LIVE_HARNESS=1, and
 * `npm test` only ever drives them through stubs.
 *
 * Auth (owner decision 2026-09-26): a subscription login and an API key are both first-class.
 * The run profile is a temporary HOME with no login, so the credential comes from the
 * environment only, never from a copied file:
 * - `claude`: ANTHROPIC_API_KEY (an API key) or CLAUDE_CODE_OAUTH_TOKEN (a subscription, from
 *   `claude setup-token`). With the key present the run is `api-key`, as D's `auto` decides;
 *   the other credential is removed from the run's environment, and the report names the mode.
 *   A subscription run's dollar figure is only an API-equivalent estimate, so it is reported as
 *   an estimate, never as provider-reported cost.
 * - `claude-sdk`: the Agent SDK runs only with an API key (Anthropic does not allow a claude.ai
 *   login through it); on a subscription, use the `claude` harness.
 *
 * `ownedRunner` (harness parity audit G19): Codex, Antigravity, Kilo and OpenCode trials run on
 * the owned-worker ports, so a trial is held to the same rules as an owned worker: tools outside
 * the run's allowedTools are denied the way each port denies them (Kilo and OpenCode deny `*` and
 * allow only the granted tools), and the run's auth mode (D's `auto`: a key for the vendor, or on
 * Kilo and OpenCode for the model's provider, means api-key) decides which credential the port
 * keeps: a login run gets no API key, and an api-key run gets no login token.
 */
import type { ModelRegistry } from '@jevris/contracts';
import { BUNDLED_MODEL_REGISTRY } from '@jevris/core';
import { harnessAuthMode, WORKER_PROVIDERS, workerAuthMode, type WorkerAuthMode, type WorkerProvider } from '@jevris/orchestrator';
import { runAntigravityWorker } from './antigravity-worker.js';
import { runCodexWorker } from './codex-worker.js';
import { isBareCommand, runCaptured } from './live-harness.js';
import { workerEnv, type AuthMode } from './harness-auth.js';
import { registryRefOf } from './harness-model.js';
import { runKiloWorker } from './kilo-worker.js';
import { runOpencodeWorker } from './opencode-worker.js';
import type { OwnedUsage, OwnedWorkerInputBase } from './owned-session.js';
import type { ArmPlan, HarnessRunInput, HarnessRunReport, HarnessRunner, ShellTool, TrialHarness } from './trial-driver.js';

type Env = { readonly [key: string]: string | undefined };

const LOG_REDUCTION_CLI = 'the harness runs its own shell tool and Jevris cannot replace its output here; log reduction runs with the claude-sdk runner';

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function rec(value: unknown): { readonly [key: string]: unknown } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { readonly [key: string]: unknown }) : null;
}

function liveGate(env: Env): string | null {
  return env['JEVRIS_LIVE_HARNESS'] === '1' ? null : 'a harness run is a billed live call; set JEVRIS_LIVE_HARNESS=1';
}

// ------------------------------------------------------------------------------ Agent SDK

/** The parts of @jevris/adapter-claude-sdk the runner uses. */
export interface OwnedWorkerModule {
  runOwnedWorker(input: {
    readonly prompt: string;
    readonly model: string;
    readonly cwd: string;
    readonly allowedTools: readonly string[];
    readonly maxTurns: number;
    readonly maxBudgetUsd: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly query?: (args: SdkQueryArgs) => unknown;
    readonly onEvent?: (event: { readonly type: string; readonly subtype?: string }) => void;
  }): Promise<{
    readonly status: HarnessRunReport['status'];
    readonly reason: string;
    readonly actualModel: string | null;
    readonly costUsd: number | null;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadInputTokens: number; readonly cacheCreationInputTokens: number } | null;
  }>;
  loadAgentSdk(): Promise<((args: SdkQueryArgs) => unknown) | null>;
}

export interface SdkQueryArgs {
  readonly prompt: string;
  readonly options: { readonly allowedTools: readonly string[]; readonly disallowedTools: readonly string[]; readonly [key: string]: unknown };
}

/** The parts of @anthropic-ai/claude-agent-sdk and zod the log-reduction tool needs. */
export interface SdkToolkit {
  createSdkMcpServer(options: { readonly name: string; readonly version: string; readonly tools: readonly unknown[] }): unknown;
  tool(name: string, description: string, shape: { readonly [key: string]: unknown }, handler: (args: { readonly command: string }, extra: unknown) => Promise<{ readonly content: readonly { readonly type: 'text'; readonly text: string }[] }>): unknown;
  stringSchema(): unknown;
}

const TRIAL_SERVER = 'jevris-trial';
export const TRIAL_SHELL_TOOL = `mcp__${TRIAL_SERVER}__shell`;

async function importOptional<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

async function defaultWorkerModule(): Promise<OwnedWorkerModule | null> {
  // A variable specifier: the adapter is an optional runtime dependency of the trial only.
  const specifier = '@jevris/adapter-claude-sdk';
  return importOptional<OwnedWorkerModule>(specifier);
}

async function defaultToolkit(): Promise<SdkToolkit | null> {
  const sdkName = '@anthropic-ai/claude-agent-sdk';
  const zodName = 'zod';
  const sdk = await importOptional<{ createSdkMcpServer?: SdkToolkit['createSdkMcpServer']; tool?: SdkToolkit['tool'] }>(sdkName);
  const zod = await importOptional<{ z?: { string(): unknown } }>(zodName);
  if (typeof sdk?.createSdkMcpServer !== 'function' || typeof sdk.tool !== 'function' || zod?.z === undefined) return null;
  const z = zod.z;
  return { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, stringSchema: () => z.string() };
}

/** The in-process MCP server that stands in for Bash under log reduction. */
export function shellToolServer(toolkit: SdkToolkit, shell: ShellTool, signal: AbortSignal): unknown {
  const tool = toolkit.tool(
    'shell',
    'Run a shell command in the task directory. Long output is reduced to the lines that matter (exit code, errors, failures); the full output stays available through the handle it prints.',
    { command: toolkit.stringSchema() },
    async (args) => ({ content: [{ type: 'text', text: await shell.run(String(args.command), signal) }] }),
  );
  return toolkit.createSdkMcpServer({ name: TRIAL_SERVER, version: '1.0.0', tools: [tool] });
}

export interface SdkRunnerOptions {
  /** Test seam for D's worker module; production imports @jevris/adapter-claude-sdk. */
  readonly worker?: OwnedWorkerModule;
  /** Test seam for the SDK query; production uses the adapter's loadAgentSdk. */
  readonly query?: (args: SdkQueryArgs) => unknown;
  readonly toolkit?: SdkToolkit;
  readonly env?: Env;
}

export function sdkRunner(options: SdkRunnerOptions = {}): HarnessRunner {
  const env = options.env ?? process.env;
  const injected = options.query !== undefined;
  return {
    harness: 'claude-sdk',
    unsupported(): string | null {
      if (injected) return null;
      const gate = liveGate(env);
      if (gate !== null) return gate;
      const key = env['ANTHROPIC_API_KEY'];
      return typeof key === 'string' && key.length > 0 ? null : 'the Agent SDK runs only with an API key (ANTHROPIC_API_KEY); on a subscription, use the claude harness with CLAUDE_CODE_OAUTH_TOKEN from claude setup-token';
    },
    async run(input: HarnessRunInput): Promise<HarnessRunReport> {
      const none = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: null, retries: null, actualModel: null };
      const worker = options.worker ?? (await defaultWorkerModule());
      if (worker === null) return { ...none, status: 'unsupported', reason: 'unsupported: @jevris/adapter-claude-sdk is not built' };
      const query = options.query ?? (await worker.loadAgentSdk());
      if (query === null) return { ...none, status: 'unsupported', reason: 'unsupported: install @anthropic-ai/claude-agent-sdk' };
      let server: unknown = null;
      if (input.shellTool !== null) {
        const toolkit = options.toolkit ?? (await defaultToolkit());
        if (toolkit === null) return { ...none, status: 'unsupported', reason: 'unsupported: the Agent SDK MCP toolkit did not load' };
        server = shellToolServer(toolkit, input.shellTool, input.signal);
      }
      const wrapped = (args: SdkQueryArgs): unknown =>
        query({
          prompt: args.prompt,
          options: {
            ...args.options,
            env: { ...input.env },
            settingSources: [],
            ...(input.plugin === null ? {} : { plugins: [{ type: 'local', path: input.plugin }] }),
            ...(server === null
              ? {}
              : {
                  mcpServers: { [TRIAL_SERVER]: server },
                  allowedTools: [...args.options.allowedTools, TRIAL_SHELL_TOOL],
                  disallowedTools: [...args.options.disallowedTools, 'Bash'],
                }),
          },
        });
      let retries = 0;
      const outcome = await worker.runOwnedWorker({
        prompt: input.prompt,
        model: input.model,
        cwd: input.cwd,
        allowedTools: server === null ? input.allowedTools : input.allowedTools.filter((tool) => tool !== 'Bash'),
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxBudgetUsd,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        query: wrapped,
        onEvent: (event) => {
          if (event.type === 'system' && event.subtype === 'api_retry') retries += 1;
        },
      });
      const usage = outcome.usage;
      return {
        status: outcome.status,
        reason: outcome.reason,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheTokens: (usage?.cacheReadInputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0),
        costUsd: outcome.costUsd,
        retries,
        actualModel: outcome.actualModel,
        authMode: 'api-key',
      };
    },
  };
}

// ------------------------------------------------------------------------------ CLI harnesses

/** The harnesses `cliRunner` drives with their own CLI flags. */
export type CliTrialHarness = 'claude' | 'kilocode' | 'opencode';

const CLI_BINARY: Readonly<Record<CliTrialHarness, string>> = { claude: 'claude', kilocode: 'kilo', opencode: 'opencode' };

/** The argv for one non-interactive run. */
export function cliArgs(harness: CliTrialHarness, input: Pick<HarnessRunInput, 'prompt' | 'model' | 'allowedTools' | 'maxBudgetUsd' | 'extraArgs'>): string[] {
  if (harness === 'claude') {
    return ['-p', input.prompt, '--output-format', 'json', '--model', input.model, '--max-budget-usd', String(input.maxBudgetUsd), '--allowedTools', input.allowedTools.join(','), ...input.extraArgs];
  }
  return ['run', '--format', 'json', '--model', input.model, ...input.extraArgs, input.prompt];
}

/** `claude -p --output-format json`: one result object. */
export function parseClaudeResult(stdout: string, exitCode: number | null): Omit<HarnessRunReport, 'status' | 'reason'> & { readonly subtype: string | null; readonly isError: boolean } {
  let result: { readonly [key: string]: unknown } | null = null;
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = rec(JSON.parse(trimmed));
      if (parsed !== null && parsed['type'] === 'result') {
        result = parsed;
        break;
      }
    } catch {
      // not the result line
    }
  }
  const usage = rec(result?.['usage']);
  const modelUsage = rec(result?.['modelUsage']);
  const top = modelUsage === null ? undefined : Object.entries(modelUsage).sort((a, b) => num(rec(b[1])?.['outputTokens']) - num(rec(a[1])?.['outputTokens']))[0];
  return {
    inputTokens: num(usage?.['input_tokens']),
    outputTokens: num(usage?.['output_tokens']),
    cacheTokens: num(usage?.['cache_read_input_tokens']) + num(usage?.['cache_creation_input_tokens']),
    costUsd: typeof result?.['total_cost_usd'] === 'number' ? (result['total_cost_usd'] as number) : null,
    retries: null,
    actualModel: top?.[0] ?? null,
    subtype: typeof result?.['subtype'] === 'string' ? (result['subtype'] as string) : null,
    isError: result === null || result['is_error'] === true || exitCode !== 0,
  };
}

/**
 * `kilo run` / `opencode run --format json`: one JSON event per line. Tokens and cost are
 * summed from each step's `tokens` and `cost`; with no cost in any event, cost is null (an
 * estimate). Not yet checked against a live run; driverConformance with JEVRIS_LIVE_HARNESS=1
 * checks it.
 */
export function parseOpencodeEvents(stdout: string): Omit<HarnessRunReport, 'status' | 'reason'> {
  let input = 0;
  let output = 0;
  let cache = 0;
  let cost: number | null = null;
  let model: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: { readonly [key: string]: unknown } | null;
    try {
      event = rec(JSON.parse(trimmed));
    } catch {
      continue;
    }
    const part = rec(event?.['part']) ?? event;
    const tokens = rec(part?.['tokens']);
    if (tokens !== null) {
      input += num(tokens['input']);
      output += num(tokens['output']) + num(tokens['reasoning']);
      const c = rec(tokens['cache']);
      cache += num(c?.['read']) + num(c?.['write']);
    }
    if (typeof part?.['cost'] === 'number' && Number.isFinite(part['cost'])) cost = (cost ?? 0) + num(part['cost']);
    if (typeof part?.['modelID'] === 'string') model = part['modelID'] as string;
  }
  return { inputTokens: input, outputTokens: output, cacheTokens: cache, costUsd: cost, retries: null, actualModel: model };
}

/** The claude run's auth mode: `api-key` when the key is present (D's `auto`), else a subscription token, else null. */
export function claudeRunAuth(env: Env): AuthMode | null {
  if ((env['ANTHROPIC_API_KEY'] ?? '') !== '') return 'api-key';
  if ((env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '') !== '') return 'subscription';
  return null;
}

const CLAUDE_NO_AUTH = 'the claude run needs ANTHROPIC_API_KEY (an API key) or CLAUDE_CODE_OAUTH_TOKEN (a subscription, from claude setup-token) in the environment; the run profile is a temporary HOME with no Claude login';

export interface CliRunnerOptions {
  /** Test seam: an absolute path to a stub binary. Production looks the harness up on PATH. */
  readonly binary?: string;
  readonly env?: Env;
}

export function cliRunner(harness: CliTrialHarness, options: CliRunnerOptions = {}): HarnessRunner {
  const env = options.env ?? process.env;
  const binary = options.binary ?? CLI_BINARY[harness];
  return {
    harness,
    unsupported(plan: ArmPlan): string | null {
      if (plan.components.includes('log-reduction')) return LOG_REDUCTION_CLI;
      if (!isBareCommand(binary)) return null;
      const gate = liveGate(env);
      if (gate !== null) return gate;
      return harness === 'claude' && claudeRunAuth(env) === null ? CLAUDE_NO_AUTH : null;
    },
    async run(input: HarnessRunInput): Promise<HarnessRunReport> {
      const auth = harness === 'claude' ? claudeRunAuth(input.env) : null;
      const runEnv = auth === null ? { ...input.env } : workerEnv('claude', auth, input.env);
      const ran = await runCaptured(binary, cliArgs(harness, input), { cwd: input.cwd, env: runEnv, timeoutMs: input.timeoutMs, signal: input.signal });
      const none = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: null, retries: null, actualModel: null };
      if (!ran.spawned) return { ...none, status: 'unsupported', reason: `${binary} did not start` };
      if (ran.aborted) return { ...none, status: 'aborted', reason: 'aborted by the caller' };
      if (ran.timedOut) return { ...none, status: 'timeout', reason: `no result within ${String(input.timeoutMs)} ms` };
      if (harness === 'claude') {
        const parsed = parseClaudeResult(ran.stdout, ran.code);
        const { subtype, isError, ...measured } = parsed;
        // On a subscription the dollar figure is an API-equivalent estimate: the driver estimates.
        const report = { ...measured, ...(auth === 'subscription' ? { costUsd: null } : {}), ...(auth === null ? {} : { authMode: auth }) };
        if (!isError && subtype === 'success') return { ...report, status: 'completed', reason: 'success' };
        if (subtype === 'error_max_budget_usd') return { ...report, status: 'budget-exceeded', reason: subtype };
        if (subtype === 'error_max_turns') return { ...report, status: 'max-turns', reason: subtype };
        return { ...report, status: 'failed', reason: subtype ?? `exit ${String(ran.code)}` };
      }
      const report = parseOpencodeEvents(ran.stdout);
      return { ...report, status: ran.code === 0 ? 'completed' : 'failed', reason: ran.code === 0 ? 'exit 0' : `exit ${String(ran.code)}` };
    },
  };
}

// ------------------------------------------------------------------------------ owned-worker ports

/** The harnesses a trial runs on an owned-worker port (G19). */
export type OwnedTrialHarness = 'codex' | 'antigravity' | 'kilocode' | 'opencode';

/** What the runner reads from any owned-worker outcome. */
interface OwnedTrialOutcome {
  readonly status: string;
  readonly reason: string;
  readonly costUsd: number | null;
  readonly usage: OwnedUsage | null;
  readonly actualModel: string | null;
  readonly authMode: AuthMode | 'unknown';
}

type OwnedRun = (input: OwnedWorkerInputBase) => Promise<OwnedTrialOutcome>;

const OWNED_RUN: Readonly<Record<OwnedTrialHarness, OwnedRun>> = {
  codex: runCodexWorker,
  antigravity: runAntigravityWorker,
  kilocode: runKiloWorker,
  opencode: runOpencodeWorker,
};

const OWNED_BINARY: Readonly<Record<OwnedTrialHarness, string>> = { codex: 'codex', antigravity: 'agy', kilocode: 'kilo', opencode: 'opencode' };
const AUTH_HARNESS: Readonly<Record<OwnedTrialHarness, 'codex' | 'antigravity' | 'kilo' | 'opencode'>> = { codex: 'codex', antigravity: 'antigravity', kilocode: 'kilo', opencode: 'opencode' };
const LOG_REDUCTION_OWNED = 'the harness runs its own shell tool and Jevris cannot replace its output here; log reduction runs with the claude-sdk runner';

/** An owned-worker status as a trial run status: anything the trial does not name is a failure with its reason. */
function trialStatus(status: string): HarnessRunReport['status'] {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'max-turns':
    case 'budget-exceeded':
    case 'aborted':
    case 'timeout':
    case 'unsupported':
    case 'refused':
      return status;
    default:
      return 'failed';
  }
}

export interface OwnedRunnerOptions {
  /** Test seam: the binary and any leading arguments. Production runs the harness on PATH. */
  readonly command?: { readonly file: string; readonly args?: readonly string[] };
  readonly env?: Env;
  /** Test seam: the owned-worker port function. */
  readonly run?: OwnedRun;
  /** The loaded model registry, so an administrator's override spells the model. Default: the bundled snapshot. */
  readonly registry?: ModelRegistry;
}

/**
 * The run's auth mode, D's `auto`: a vendor key in the run's environment means api-key, else the
 * subscription. On OpenCode and Kilo the key is the model provider's (a Claude model looks for
 * ANTHROPIC_API_KEY); a model the registry does not place under a provider runs on the login.
 */
function trialAuthMode(harness: OwnedTrialHarness, model: string, registry: ModelRegistry, env: Env): WorkerAuthMode {
  const key = AUTH_HARNESS[harness];
  if (key !== 'opencode' && key !== 'kilo') return workerAuthMode(key, undefined, env);
  const provider = registryRefOf(registry, harness, model)?.provider;
  if (provider === undefined || !(WORKER_PROVIDERS as readonly string[]).includes(provider)) return 'subscription';
  return harnessAuthMode(key, provider as WorkerProvider, undefined, env);
}

/** A trial runner on the harness's owned-worker port (G19). */
export function ownedRunner(harness: OwnedTrialHarness, options: OwnedRunnerOptions = {}): HarnessRunner {
  const env = options.env ?? process.env;
  const run = options.run ?? OWNED_RUN[harness];
  return {
    harness,
    unsupported(plan: ArmPlan): string | null {
      if (plan.components.includes('log-reduction')) return LOG_REDUCTION_OWNED;
      return options.command === undefined && options.run === undefined ? liveGate(env) : null;
    },
    async run(input: HarnessRunInput): Promise<HarnessRunReport> {
      const registry = options.registry ?? BUNDLED_MODEL_REGISTRY;
      const auth = trialAuthMode(harness, input.model, registry, input.env);
      const outcome = await run({
        prompt: input.prompt,
        model: input.model,
        cwd: input.cwd,
        allowedTools: input.allowedTools,
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxBudgetUsd,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        auth,
        env: input.env,
        command: options.command ?? { file: OWNED_BINARY[harness] },
        registry,
      });
      const usage = outcome.usage;
      return {
        status: trialStatus(outcome.status),
        reason: outcome.status === trialStatus(outcome.status) ? outcome.reason : `${outcome.status}: ${outcome.reason}`,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheTokens: (usage?.cacheReadInputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0),
        // On a subscription a dollar figure is only an API-equivalent estimate: the driver estimates.
        costUsd: outcome.authMode === 'subscription' ? null : outcome.costUsd,
        retries: null,
        actualModel: outcome.actualModel,
        ...(outcome.authMode === 'unknown' ? {} : { authMode: outcome.authMode }),
      };
    },
  };
}

/** The runner for a trial config's harness. */
export function runnerFor(harness: TrialHarness, env: Env = process.env): HarnessRunner {
  if (harness === 'claude-sdk') return sdkRunner({ env });
  if (harness === 'claude') return cliRunner(harness, { env });
  return ownedRunner(harness, { env });
}
