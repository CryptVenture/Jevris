import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GlobalHarness, HarnessCli } from './global-harness.js';
import { LAUNCHER } from './global-harness.js';
import * as claudeAdapter from '@jevris/adapter-claude-code';
import * as codexAdapter from '@jevris/adapter-codex';
import * as kilocodeAdapter from '@jevris/adapter-kilocode';
import * as opencodeAdapter from '@jevris/adapter-opencode';
import { nodeConfigHost, projectConfigFiles, projectConfigGuard } from '@jevris/adapter-kilocode';
import { BUNDLED_MODEL_REGISTRY, classifyAccessSignal } from '@jevris/core';
import type { AccessLimitClass, AccessSignalWire, ModelRegistry } from '@jevris/contracts';
import { claudeTranscriptAccess, codexTranscriptAccess, opencodeTranscriptAccess } from './access-signal.js';
import { codexExecArgs } from './codex-worker.js';
import { launchInteractive, type InteractiveLaunch } from './live-harness.js';
import { LISTING_STDOUT_CAP, LISTING_TIMEOUT_MS, listingArgv, listingEnv, parseProviderListing } from './model-offer.js';
import { startStubProvider, type StubProvider, type StubProviderOptions, type StubReply, type StubRequest } from './stub-provider.js';
import { CODEX_STUB_PROVIDER, stubProfile, type StubProfile } from './stub-profile.js';
import { codexUsageReadCase } from './usage-read-case.js';

/**
 * Certify cases that run one real model turn against the loopback stub provider (owner decision
 * OD-9; routing design R33). The harness runs in certify's throwaway profile, in an empty folder
 * inside it, with A's stub profile: every model request goes to 127.0.0.1 with the dummy key, so
 * no provider is called and nothing is billed. Antigravity has no custom endpoint, so it has no
 * case here (owner-run).
 *
 * This first set reports; it gates nothing yet. A case's result goes into certify's output and its
 * evidence, and a case becomes a gate for its feature only after the owner's certify shows it
 * passing on the real binary:
 * - `claude.hook-spawn` (audit G17): the installed Jevris hook process starts in a real Claude
 *   Code turn. A `--require`d observer (through NODE_OPTIONS) notes each node process that starts
 *   the runtime's hook entry.
 * - `<kilocode|opencode>.system-transform` (G4, the vendor half): a probe plugin's
 *   `experimental.chat.system.transform` text reaches the model request's system prompt.
 * - `claude.subagent-route` (K1): a PreToolUse probe's `updatedInput.model` (the `haiku` alias,
 *   no permission decision) reaches the subagent's model request, while the session runs Opus.
 * - `<kilocode|opencode>.session-route` (OD-8): a probe plugin's chat.message sets
 *   output.message.model on a top-level turn, and the turn runs on that model.
 * - `<kilocode|opencode>.subagent-route` (K3, K4: chat.message of the child session): the subagent
 *   runs on the probe's model while the parent keeps its own. Kilo's task tool ignores a model
 *   argument (the owner's certify run, 2026-09-28), so both harnesses are routed, and proven, on
 *   the child session's first message.
 * - `codex.store` (K12): whether Codex sends `store` on its Responses request, and its value.
 * - `<kilocode|opencode>.models-list-hosts` (K13, feature `models.list-hosts`; serving hosts R57):
 *   the harness's own listing, with gateway and host providers in the profile's inline config,
 *   prints host lines the one resolver keeps as their own spellings (`openrouter/moonshotai/kimi-k3`)
 *   and drops a `:free` or `~` line.
 * - `<kilocode|opencode>.session-route-host` (K14, feature `route.host`): a probe plugin switches a
 *   turn on `openrouter/moonshotai/kimi-k3` to `openrouter/z-ai/glm-5.3`. The turn reaches the same
 *   provider (the stub's `/openrouter` path) with the nested model id, the next turn returns to the
 *   session's model, and the installed adapter's project config guard, run on the directory the
 *   harness gave the plugin, allows the route there.
 * - `<kilocode|opencode>.session-route-host-redefined` (K15, T-R6): the same, with a project config
 *   in the working folder that redefines `provider.openrouter`. The guard, run on the directory
 *   the harness gave the plugin, must refuse a route to that provider.
 * - `<codex|opencode|kilocode>.worker-actual-model` (K8, feature `worker.actual-model`): a turn
 *   started as an owned worker starts it (the worker's own argv and `--model`) reports, to a probe
 *   hook or plugin, the model its request actually carried. Codex: the `model` of SessionStart and
 *   UserPromptSubmit. Kilo and OpenCode: chat.message's `model` and the assistant message's
 *   provider and model (message.updated).
 * - `codex.subagent-route` (K2, OD-6): a turn in `codex app-server` with approval policy
 *   `on-request` and the read-only sandbox. The parent calls `spawn_agent`; a PreToolUse probe
 *   answers it with the exact bytes the installed Codex adapter renders for that call's route
 *   (`permissionDecision: "allow"`, the call's own input plus `model`), and the subagent's request
 *   must carry that model. The subagent then asks to run a write outside the sandbox
 *   (`require_escalated`): Codex must still send the approval request to the client, which
 *   declines it, and the file must not appear. A subagent shell call the probe never saw, or no
 *   approval request, fails the case: the allow must be shown to skip no approval or sandbox check.
 *   The spawned child runs on its own thread, so the case waits for the child's turn as well as
 *   the parent's.
 *
 * - `<claude|codex|opencode|kilocode>.access-limit.<rate|credit|auth>` (K16-K18, feature
 *   `access.detect`; access limits R69): the stub answers every model request with a scripted
 *   error in the API's own shape (a 429 with `retry-after: 1` and a reset header 30 minutes ahead,
 *   a credit error, a 401). The run's transcript, read by the owned-worker port's own parser, must
 *   give a signal core classifies as `rate-limit`, `credit-exhausted` or `account-blocked`.
 *   Claude Code retries a 429 and a 401 itself (code.claude.com/docs/en/errors, "Automatic
 *   retries"), so its cases run with CLAUDE_CODE_MAX_RETRIES=1 and without
 *   CLAUDE_CODE_RETRY_WATCHDOG (code.claude.com/docs/en/env-vars), as Codex's set its provider's
 *   request_max_retries=0.
 * - `claude.session.stop-failure` (K19, feature `access.session`): K17's 402 in a `-p` turn with a
 *   StopFailure probe hook. The hook must fire with `error: "billing_error"` (the hooks reference,
 *   code.claude.com/docs/en/hooks#stopfailure: `error`, optional `error_details` and
 *   `last_assistant_message`), and the installed Claude adapter must keep no text of that payload.
 * - `<kilocode|opencode>.session.error` (K20, feature `access.session`): K17's 402; a probe plugin
 *   must see `session.error` or a failed assistant message with an APIError and status 402, and
 *   the installed adapter must keep no text of it.
 * - `codex.usage-read` (K21, feature `access.usage-read`; usage-read-case.ts): `codex app-server`
 *   answers `account/rateLimits/read` from a loopback stub under OS network isolation
 *   (sandbox-exec on macOS, a network namespace on Linux). Where none can be set up, the case
 *   is ACCESS_USAGE_ISOLATION_UNAVAILABLE.
 *   Every scripted error body and header carries ACCESS_CANARY; a case fails if it reaches a
 *   signal, a finding, a normalized event or the case's own result.
 *
 * Codex runs a hook only once it is trusted. The Codex cases give their probe hooks as `--config`
 * session flags, with `--dangerously-bypass-hook-trust` (exec) or the thread's `bypass_hook_trust`
 * (app-server) for that one run, so nothing is written to the profile's trust state; neither
 * exists outside these throwaway-profile probes, never in an owned run.
 */

type Env = { readonly [key: string]: string | undefined };

export interface StubCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly reasonCode: string | null;
  readonly detail: string;
  /** Names only (K2): what the harness and the case said, for the conformance evidence. */
  readonly trace?: readonly StubTraceEntry[];
}

/**
 * One trace entry (coordinator's decision after the owner's RC5 run): who spoke, a method, event,
 * item type or tool name (never content), and a thread role, never a thread id. Consecutive
 * repeats are counted.
 */
export interface StubTraceEntry {
  readonly from: 'server' | 'client' | 'hook' | 'stub';
  readonly name: string;
  readonly thread: string;
  readonly count: number;
}

/** The most entries one trace keeps, and the shape a traced name must have (the evidence contract's). */
export const STUB_TRACE_LIMIT = 256;
const TRACE_NAME = /^[A-Za-z0-9_./:-]{1,96}$/;

export interface StubTrace {
  add(from: StubTraceEntry['from'], name: string, thread: string): void;
  entries(): readonly StubTraceEntry[];
}

/**
 * A bounded trace: a name that is not a plain name is recorded as `unnamed`. Past the limit it
 * keeps the first entries and the most recent ones, with one `elided` entry counting what fell
 * between, so the end of a long run (where a case fails) stays in the evidence.
 */
export function createStubTrace(): StubTrace {
  type Entry = { from: StubTraceEntry['from']; name: string; thread: string; count: number };
  const HEAD = STUB_TRACE_LIMIT - 64;
  const TAIL = STUB_TRACE_LIMIT - HEAD - 1;
  const head: Entry[] = [];
  let tail: Entry[] = [];
  let elided = 0;
  return {
    add(from, name, thread) {
      const safe = TRACE_NAME.test(name) ? name : 'unnamed';
      const open = tail.length > 0 || elided > 0 ? tail : head;
      const last = open[open.length - 1];
      if (last !== undefined && last.from === from && last.name === safe && last.thread === thread) {
        last.count = Math.min(last.count + 1, 1_000_000);
        return;
      }
      const entry = { from, name: safe, thread, count: 1 };
      if (open === head && head.length < HEAD) {
        head.push(entry);
        return;
      }
      tail.push(entry);
      if (tail.length > TAIL) {
        elided += 1;
        tail = tail.slice(1);
      }
    },
    entries: () => [
      ...head.map((item) => ({ ...item })),
      ...(elided > 0 ? [{ from: 'stub' as const, name: 'elided', thread: 'none', count: Math.min(elided, 1_000_000) }] : []),
      ...tail.map((item) => ({ ...item })),
    ],
  };
}

export interface StubCaseContext {
  readonly harness: GlobalHarness;
  readonly cli: HarnessCli;
  /** certifyEnv's environment for the profile. */
  readonly env: Env;
  readonly profile: string;
  /** The runtime's hook entry the installed plugin runs, when known. */
  readonly hookEntry: string | null;
  readonly timeoutMs?: number;
  /** Tests: another stub starter. */
  readonly startStub?: (options: StubProviderOptions) => Promise<StubProvider>;
  /** Tests: another stdio launcher for K2's `codex app-server` session. */
  readonly launchInteractive?: typeof launchInteractive;
}

/** The model each case asks for: one the stub answers as any other, and the harness accepts by name. */
export const STUB_CASE_MODELS: Readonly<Record<'claude' | 'codex' | 'opencode' | 'kilocode', string>> = {
  claude: 'claude-haiku-4-5',
  codex: 'gpt-5.5',
  opencode: 'claude-haiku-4-5',
  kilocode: 'claude-haiku-4-5',
};
export const STUB_CASE_TIMEOUT_MS = 60_000;
const PROMPT = 'Reply with the single word ok.';
const MARKER = 'JEVRIS-STUB-PROBE-SYSTEM-TEXT';

const OBSERVER = [
  "'use strict';",
  'const fs = require("node:fs");',
  'const marker = process.env.JEVRIS_STUB_PROBE_MARKER;',
  'if (typeof marker === "string" && marker.length > 0) {',
  '  try { fs.appendFileSync(marker, JSON.stringify({ argv: process.argv.slice(0, 2) }) + "\\n"); } catch (error) {}',
  '}',
  '',
].join('\n');

function probePlugin(marker: string): string {
  return [
    '// Jevris certify probe (throwaway profile only): adds one marker line to the system prompt.',
    'export const JevrisStubProbe = async () => ({',
    "  'experimental.chat.system.transform': async (_input, output) => {",
    `    if (output && Array.isArray(output.system)) output.system.push(${JSON.stringify(marker)});`,
    '  },',
    '});',
    '',
  ].join('\n');
}

/** The file URL of a local path on this platform (a plugin entry in the harness config). */
export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

function result(id: string, passed: boolean, reasonCode: string | null, detail: string): StubCaseResult {
  return { id, passed, reasonCode: passed ? null : reasonCode, detail };
}

function modelRequests(requests: readonly StubRequest[]): readonly StubRequest[] {
  return requests.filter((item) => item.shape === 'anthropic-messages' || item.shape === 'openai-responses' || item.shape === 'openai-chat');
}

/** Why the stub saw no usable model request. */
function stubMiss(id: string, requests: readonly StubRequest[], code: number): StubCaseResult | null {
  const models = modelRequests(requests);
  if (models.some((item) => item.refused)) return result(id, false, 'STUB_KEY_REFUSED', `the model request carried a key other than the stub's (another sign-in outranked the dummy key); exit ${code}`);
  if (models.length === 0) return result(id, false, 'STUB_NOT_REACHED', `no model request reached the stub (exit ${code}); the harness may have used another endpoint`);
  return null;
}

async function realOrSame(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Whether the observer saw a node process start the hook entry. */
export async function hookEntryStarted(markerFile: string, hookEntry: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(markerFile, 'utf8');
  } catch {
    return false;
  }
  const want = new Set([hookEntry, await realOrSame(hookEntry)]);
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const argv = (JSON.parse(line) as { argv?: unknown }).argv;
      if (Array.isArray(argv) && typeof argv[1] === 'string' && (want.has(argv[1]) || want.has(await realOrSame(argv[1])))) return true;
    } catch {
      // A torn line is not a start.
    }
  }
  return false;
}

async function withStub(ctx: StubCaseContext, options: StubProviderOptions, run: (stub: StubProvider, work: string) => Promise<StubCaseResult>): Promise<StubCaseResult> {
  const start = ctx.startStub ?? startStubProvider;
  const stub = await start(options);
  try {
    const work = join(ctx.profile, 'jevris-stub-case');
    await mkdir(work, { recursive: true });
    return await run(stub, work);
  } finally {
    await stub.close();
  }
}

function profileFor(ctx: StubCaseContext, stub: StubProvider, model: string, codexConfig?: string): StubProfile | null {
  return stubProfile(ctx.harness, stub, ctx.env, { model, ...(codexConfig === undefined ? {} : { codexConfig }) });
}

/**
 * K1's probe hook: a PreToolUse command that rewrites an Agent (Task) call's `model` to the
 * `haiku` alias with `updatedInput` and no permission decision, as Jevris's route renders it.
 */
const ROUTE_PROBE = [
  "'use strict';",
  'let text = "";',
  'process.stdin.on("data", (chunk) => { text += chunk; });',
  'process.stdin.on("end", () => {',
  '  let input;',
  '  try { input = JSON.parse(text); } catch (error) { return; }',
  '  if (!input || (input.tool_name !== "Agent" && input.tool_name !== "Task")) return;',
  '  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};',
  '  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, model: "haiku" } } }));',
  '});',
  '',
].join('\n');

/**
 * A stub script that answers the first request offering `tool` with one call to it, and every
 * other request with text. A title or summary request (no tools) is never the one.
 */
function spawnOnce(tool: string, input: { readonly [key: string]: unknown }): (request: StubRequest) => StubReply | undefined {
  let called = false;
  return (request) => {
    if (called || !request.toolNames.includes(tool)) return undefined;
    called = true;
    return { kind: 'tool', name: tool, input };
  };
}

/** The main session's model in K1, and the family a routed subagent must reach instead. */
export const K1_MAIN_MODEL = 'claude-opus-5-5';
const K1_ROUTED = /haiku/i;

async function claudeSubagentRoute(ctx: StubCaseContext): Promise<StubCaseResult> {
  const id = 'claude.subagent-route';
  const script = spawnOnce('Agent', { description: 'Jevris probe', prompt: 'Reply with the single word ok.', subagent_type: 'general-purpose' });
  return withStub(ctx, { script }, async (stub, work) => {
    const profile = profileFor(ctx, stub, K1_MAIN_MODEL);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', 'no stub profile for Claude Code');
    const probe = join(work, 'route-probe.cjs');
    await writeFile(probe, ROUTE_PROBE);
    const settings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}`, timeout: 10 }] }] } });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', '4', '--model', K1_MAIN_MODEL, '--settings', settings, PROMPT];
    const ran = await ctx.cli.run(LAUNCHER.claude, args, ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, profile.env, { cwd: work });
    const missed = stubMiss(id, stub.requests(), ran.code);
    if (missed !== null) return missed;
    const models = modelRequests(stub.requests()).map((item) => item.model ?? '');
    const later = models.slice(1);
    if (later.length === 0) return result(id, false, 'SUBAGENT_NOT_STARTED', `only the main turn reached the stub (${models[0] ?? 'no model'}); the scripted Agent call started no subagent`);
    const routed = later.find((model) => K1_ROUTED.test(model));
    return routed !== undefined
      ? result(id, true, null, `updatedInput.model "haiku" with no permission decision was honoured: the subagent asked for ${routed} while the session ran ${models[0] ?? K1_MAIN_MODEL}`)
      : result(id, false, 'ROUTE_IGNORED', `the subagent asked for ${later.join(', ')}, not a haiku model: updatedInput.model without a permission decision was not honoured`);
  });
}

async function claudeHookSpawn(ctx: StubCaseContext): Promise<StubCaseResult> {
  const id = 'claude.hook-spawn';
  if (ctx.hookEntry === null) return result(id, false, 'NO_HOOK_ENTRY', 'the runtime names no hook entry');
  const hookEntry = ctx.hookEntry;
  return withStub(ctx, {}, async (stub, work) => {
    const profile = profileFor(ctx, stub, STUB_CASE_MODELS.claude);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', 'no stub profile for Claude Code');
    const observer = join(work, 'observer.cjs');
    const marker = join(work, 'hook-starts.jsonl');
    await writeFile(observer, OBSERVER);
    const env = { ...profile.env, NODE_OPTIONS: `--require ${JSON.stringify(observer)}`, JEVRIS_STUB_PROBE_MARKER: marker };
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--no-session-persistence', '--max-turns', '1', '--model', STUB_CASE_MODELS.claude, PROMPT];
    const ran = await ctx.cli.run(LAUNCHER.claude, args, ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, env, { cwd: work });
    const missed = stubMiss(id, stub.requests(), ran.code);
    const started = await hookEntryStarted(marker, hookEntry);
    if (!started) return result(id, false, 'HOOK_NOT_SPAWNED', `the Jevris hook entry never started in the turn (exit ${ran.code})${missed === null ? '' : `; ${missed.detail}`}`);
    if (missed !== null) return missed;
    return result(id, true, null, `the Jevris hook started in a real turn; ${modelRequests(stub.requests()).length} model request(s) reached the stub, none billed`);
  });
}

type PluginHarness = 'opencode' | 'kilocode';

/** Runs one `run --format json` turn with a probe plugin and extra config; resolves with the stub's requests, or a failed result. */
async function pluginTurn(
  ctx: StubCaseContext,
  harness: PluginHarness,
  id: string,
  stubOptions: StubProviderOptions,
  plugin: string,
  extra: { readonly [key: string]: unknown },
  judge: (requests: readonly StubRequest[], firstTurn: number) => StubCaseResult,
  followUp?: string,
): Promise<StubCaseResult> {
  return withStub(ctx, stubOptions, async (stub, work) => {
    const profile = profileFor(ctx, stub, STUB_CASE_MODELS[harness]);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', `no stub profile for ${harness}`);
    const file = join(work, `jevris-stub-probe-${id.replace(/[^a-z0-9-]/g, '-')}.mjs`);
    await writeFile(file, plugin);
    const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
    let config: { [key: string]: unknown };
    try {
      config = JSON.parse(profile.env[key] ?? '{}') as { [key: string]: unknown };
    } catch {
      return result(id, false, 'NO_STUB_PROFILE', 'the stub config did not parse');
    }
    const env = { ...profile.env, [key]: JSON.stringify({ ...config, ...extra, plugin: [fileUrl(file)] }) };
    const ran = await ctx.cli.run(LAUNCHER[harness], ['run', '--format', 'json', PROMPT], ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, env, { cwd: work });
    const missed = stubMiss(id, stub.requests(), ran.code);
    if (missed !== null) return missed;
    const firstTurn = stub.requests().length;
    // A second turn in the same session (`run --continue`, no --model), when the case asks for one.
    if (followUp !== undefined) await ctx.cli.run(LAUNCHER[harness], ['run', '--continue', '--format', 'json', followUp], ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, env, { cwd: work });
    return judge(stub.requests(), firstTurn);
  });
}

async function systemTransform(ctx: StubCaseContext, harness: PluginHarness): Promise<StubCaseResult> {
  const id = `${harness}.system-transform`;
  return pluginTurn(ctx, harness, id, { markers: [MARKER] }, probePlugin(MARKER), {}, (requests) =>
    modelRequests(requests).some((item) => item.markersSeen.some((found) => found.marker === MARKER && found.where === 'system'))
      ? result(id, true, null, "a plugin's experimental.chat.system.transform text reached the model request's system prompt")
      : result(id, false, 'SYSTEM_TEXT_MISSING', "the model request reached the stub without the probe plugin's system text"),
  );
}

/** The session's configured model in the route cases, and the model a probe routes to. */
export const ROUTE_CASE_MODELS = { session: 'claude-sonnet-4-5', routed: 'claude-haiku-4-5' } as const;

/** Text in session-route's second prompt: the probe never routes a message that carries it. */
export const UNROUTED_MARK = 'JEVRIS-STUB-UNROUTED-TURN';
const FOLLOW_UP_PROMPT = `Reply with the single word ok. ${UNROUTED_MARK}`;

/**
 * The route probe plugin. `main`: chat.message of a top-level session sets output.message.model
 * (OD-8), except on a message whose text carries UNROUTED_MARK. `child`: chat.message of a child
 * session sets it (K3, K4). Child sessions are learned from session.created's parentID.
 */
export function routeProbePlugin(mode: 'main' | 'child'): string {
  const routed = JSON.stringify(ROUTE_CASE_MODELS.routed);
  return [
    '// Jevris certify probe (throwaway profile only): routes one turn to another model.',
    'export const JevrisStubProbe = async () => {',
    '  const children = new Set();',
    '  return {',
    '    event: async ({ event }) => {',
    "      if (event && event.type === 'session.created' && event.properties && event.properties.info && event.properties.info.parentID) children.add(event.properties.info.id);",
    '    },',
    "    'chat.message': async (input, output) => {",
    `      const child = children.has(input && input.sessionID);`,
    `      if (${JSON.stringify(mode)} === 'main' ? child : !child) return;`,
    '      const parts = output && Array.isArray(output.parts) ? output.parts : [];',
    `      if (parts.some((part) => part && typeof part.text === 'string' && part.text.includes(${JSON.stringify(UNROUTED_MARK)}))) return;`,
    `      if (output && output.message) output.message.model = { providerID: 'anthropic', modelID: ${routed} };`,
    '    },',
    '  };',
    '};',
    '',
  ].join('\n');
}

/** Agent requests only: they offer tools. A title or summary request offers none. */
function agentRequests(requests: readonly StubRequest[]): readonly StubRequest[] {
  return modelRequests(requests).filter((item) => item.toolNames.length > 0);
}

/**
 * OD-8: the probe routes the first top-level turn. That turn must run on the routed model, and a
 * second turn in the same session, which the probe leaves alone, on the session's own model: a
 * switch changes one turn and never the session's stored model.
 */
async function sessionRoute(ctx: StubCaseContext, harness: PluginHarness): Promise<StubCaseResult> {
  const id = `${harness}.session-route`;
  const config = { model: `anthropic/${ROUTE_CASE_MODELS.session}`, small_model: `anthropic/${ROUTE_CASE_MODELS.session}` };
  return pluginTurn(
    ctx,
    harness,
    id,
    {},
    routeProbePlugin('main'),
    config,
    (requests, firstTurn) => {
      const first = agentRequests(requests.slice(0, firstTurn))[0];
      if (first === undefined) return result(id, false, 'NO_AGENT_REQUEST', 'no agent request (one that offers tools) reached the stub');
      if (first.model !== ROUTE_CASE_MODELS.routed) return result(id, false, 'ROUTE_IGNORED', `the turn ran on ${first.model ?? 'no model'}, not the ${ROUTE_CASE_MODELS.routed} the probe set in chat.message`);
      const next = agentRequests(requests.slice(firstTurn))[0];
      if (next === undefined) return result(id, false, 'SECOND_TURN_NOT_RUN', 'the second, unrouted turn of the session sent no agent request');
      return next.model === ROUTE_CASE_MODELS.session
        ? result(id, true, null, `chat.message's output.message.model ran the turn on ${first.model} instead of the configured ${ROUTE_CASE_MODELS.session}, and the next unrouted turn ran on ${next.model}`)
        : result(id, false, 'ROUTE_STUCK', `the next, unrouted turn ran on ${next.model ?? 'no model'}, not the session's ${ROUTE_CASE_MODELS.session}: the switch outlived its turn`);
    },
    FOLLOW_UP_PROMPT,
  );
}

async function subagentRoute(ctx: StubCaseContext, harness: PluginHarness): Promise<StubCaseResult> {
  const id = `${harness}.subagent-route`;
  const config = { model: `anthropic/${ROUTE_CASE_MODELS.session}`, small_model: `anthropic/${ROUTE_CASE_MODELS.session}` };
  const script = spawnOnce('task', { description: 'Jevris probe', prompt: 'Reply with the single word ok.', subagent_type: 'general' });
  return pluginTurn(ctx, harness, id, { script }, routeProbePlugin('child'), config, (requests) => {
    const agents = agentRequests(requests);
    const [main, ...later] = agents;
    if (main === undefined) return result(id, false, 'NO_AGENT_REQUEST', 'no agent request (one that offers tools) reached the stub');
    if (later.length === 0) return result(id, false, 'SUBAGENT_NOT_STARTED', 'the scripted task call started no subagent request');
    const how = "a child session's chat.message output.message.model";
    const routed = later.find((item) => item.model === ROUTE_CASE_MODELS.routed);
    const parentAfter = later.filter((item) => item.model === ROUTE_CASE_MODELS.session).length;
    return routed !== undefined
      ? result(id, true, null, `${how} ran the subagent on ${ROUTE_CASE_MODELS.routed} while the session ran ${main.model ?? ROUTE_CASE_MODELS.session}${parentAfter > 0 ? '; the parent kept its model' : ''}`)
      : result(id, false, 'ROUTE_IGNORED', `the subagent asked for ${later.map((item) => item.model ?? 'no model').join(', ')}, not ${ROUTE_CASE_MODELS.routed}: ${how} was not honoured`);
  });
}

/**
 * Runs `run` with the stub provider written into the profile's Codex config; the profile's own
 * config.toml comes back afterwards, so later checks see what install wrote.
 */
async function withCodexProfile(ctx: StubCaseContext, id: string, stubOptions: StubProviderOptions, model: string, run: (stub: StubProvider, work: string, profile: StubProfile) => Promise<StubCaseResult>): Promise<StubCaseResult> {
  return withStub(ctx, stubOptions, async (stub, work) => {
    const home = ctx.env['CODEX_HOME'];
    if (home === undefined) return result(id, false, 'NO_STUB_PROFILE', 'CODEX_HOME is not set');
    const configPath = join(home, 'config.toml');
    let existing: string | null = null;
    try {
      existing = await readFile(configPath, 'utf8');
    } catch {
      existing = null;
    }
    let profile: StubProfile | null;
    try {
      profile = profileFor(ctx, stub, model, existing ?? '');
    } catch {
      return result(id, false, 'NO_STUB_PROFILE', 'the profile config.toml could not take the stub provider');
    }
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', 'no stub profile for Codex');
    try {
      for (const file of profile.files) await writeFile(file.path, file.content);
      return await run(stub, work, profile);
    } finally {
      if (existing === null) await rm(configPath, { force: true }).catch(() => undefined);
      else await writeFile(configPath, existing).catch(() => undefined);
    }
  });
}

async function codexStore(ctx: StubCaseContext): Promise<StubCaseResult> {
  const id = 'codex.store';
  return withCodexProfile(ctx, id, {}, STUB_CASE_MODELS.codex, async (stub, work, profile) => {
    const ran = await ctx.cli.run(LAUNCHER.codex, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', PROMPT], ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, profile.env, { cwd: work });
    const missed = stubMiss(id, stub.requests(), ran.code);
    if (missed !== null) return missed;
    const stores = [...new Set(modelRequests(stub.requests()).map((item) => (item.store === null ? 'absent' : String(item.store))))];
    return result(id, true, null, `the Responses request sends store: ${stores.join(', ')}`);
  });
}

/** What a probe hook or plugin wrote: one JSON object per line, ids and model names only. */
export interface ProbeRecord {
  readonly event: string | null;
  readonly model: string | null;
  readonly tool: string | null;
  readonly role: string | null;
  /** K2: whether the probe answered this event (the spawn_agent call it expected). */
  readonly answered: boolean;
  /** Codex: the hook input's `agent_id`, the subagent's thread id (null in the parent). Kept in memory only. */
  readonly agent?: string | null;
}

/** The probe's records; a torn or foreign line is skipped. */
export async function readProbeRecords(file: string): Promise<readonly ProbeRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: ProbeRecord[] = [];
  const str = (value: unknown, cap: number): string | null => (typeof value === 'string' && value.length > 0 ? value.slice(0, cap) : null);
  for (const line of text.split('\n').slice(0, 512)) {
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as { [key: string]: unknown };
      out.push({ event: str(value['event'], 64), model: str(value['model'], 160), tool: str(value['tool'], 64), role: str(value['role'], 32), answered: value['answered'] === true, agent: str(value['agent'], 128) });
    } catch {
      // A torn line is not a record.
    }
  }
  return out;
}

/** K2's answer: the spawn_agent input the probe expects, and the exact text it prints for it. */
export interface CodexProbeRoute {
  readonly input: { readonly [key: string]: unknown };
  readonly text: string;
}

/**
 * The Codex probe hook (a command hook for every event): it notes the event, the hook's `model`
 * and the tool name, never any input text. With a route (K2) it answers exactly one thing: a
 * PreToolUse(spawn_agent) whose input equals the expected input, key for key, gets the given
 * text, which is what the installed Codex adapter renders for that call. spawn_agent is either of
 * the names the adapter reads as spawn_agent (SPAWN_HOOK_NAMES: plain, or Codex's default
 * MultiAgentV2 namespace name `collaborationspawn_agent`). Every other event, and
 * every shell call, gets no answer, as from the installed hook.
 */
export function codexProbeHook(markerFile: string, route: CodexProbeRoute | null): string {
  return [
    "'use strict';",
    'const fs = require("node:fs");',
    `const MARKER = ${JSON.stringify(markerFile)};`,
    `const ROUTE = ${JSON.stringify(route)};`,
    `const SPAWN = ${JSON.stringify(codexAdapter.SPAWN_HOOK_NAMES)};`,
    'const str = (value, cap) => (typeof value === "string" && value.length > 0 ? value.slice(0, cap) : null);',
    'const canon = (value) => Array.isArray(value) ? value.map(canon) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])])) : value;',
    'const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));',
    'let text = "";',
    'process.stdin.on("data", (chunk) => { if (text.length < 1048576) text += chunk; });',
    'process.stdin.on("end", () => {',
    '  let input;',
    '  try { input = JSON.parse(text); } catch (error) { return; }',
    '  if (!input || typeof input !== "object") return;',
    '  const answered = ROUTE !== null && input.hook_event_name === "PreToolUse" && SPAWN.includes(input.tool_name) && same(input.tool_input, ROUTE.input);',
    '  const record = { event: str(input.hook_event_name, 64), model: str(input.model, 160), tool: str(input.tool_name, 64), agent: str(input.agent_id, 128), answered };',
    '  try { fs.appendFileSync(MARKER, JSON.stringify(record) + "\\n"); } catch (error) {}',
    '  if (answered) process.stdout.write(ROUTE.text);',
    '});',
    '',
  ].join('\n');
}

/** The Codex hook events the probe listens to. */
const CODEX_PROBE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart'] as const;

/** `--config` session flags that register the probe for each event. */
export function codexProbeConfig(probeFile: string): readonly string[] {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(probeFile)}`;
  const group = `[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`;
  return CODEX_PROBE_EVENTS.flatMap((event) => ['--config', `hooks.${event}=${group}`]);
}

/** codexProbeConfig plus the exec flag that runs the probe untrusted, for this run only. */
export function codexProbeFlags(probeFile: string): readonly string[] {
  return ['--dangerously-bypass-hook-trust', ...codexProbeConfig(probeFile)];
}

/** The model a K8 case asks each harness for, as the owned worker would pass it. */
export const K8_MODELS: Readonly<Record<'codex' | PluginHarness, string>> = {
  codex: STUB_CASE_MODELS.codex,
  opencode: `anthropic/${STUB_CASE_MODELS.opencode}`,
  kilocode: `anthropic/${STUB_CASE_MODELS.kilocode}`,
};

/** K8's verdict: the model the hooks reported against the one the request carried. */
export function actualModelVerdict(id: string, requested: string, requestModel: string | null, reported: readonly { readonly source: string; readonly model: string }[]): StubCaseResult {
  if (reported.length === 0) return result(id, false, 'MODEL_NOT_REPORTED', `the run's hooks reported no model; the request carried ${requestModel ?? 'no model'}`);
  const bare = (model: string): string => model.slice(model.lastIndexOf('/') + 1);
  const matching = reported.filter((item) => requestModel !== null && (item.model === requestModel || bare(item.model) === bare(requestModel)));
  const sources = [...new Set(matching.map((item) => item.source))];
  if (matching.length === 0) {
    const seen = [...new Set(reported.map((item) => `${item.source} ${item.model}`))].join(', ');
    return result(id, false, 'MODEL_MISREPORTED', `the hooks reported ${seen}, but the request carried ${requestModel ?? 'no model'} (asked for ${requested})`);
  }
  return result(id, true, null, `${sources.join(' and ')} reported ${matching[0]?.model ?? ''}, the model the request carried (asked for ${requested})`);
}

async function codexActualModel(ctx: StubCaseContext): Promise<StubCaseResult> {
  const id = 'codex.worker-actual-model';
  return withCodexProfile(ctx, id, {}, K8_MODELS.codex, async (stub, work, profile) => {
    const marker = join(work, 'k8-codex.jsonl');
    const probe = join(work, 'k8-codex-probe.cjs');
    await rm(marker, { force: true });
    await writeFile(probe, codexProbeHook(marker, null));
    const args = [...codexExecArgs(K8_MODELS.codex, 'read-only'), ...codexProbeFlags(probe), PROMPT];
    const ran = await ctx.cli.run(LAUNCHER.codex, args, ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, profile.env, { cwd: work });
    const missed = stubMiss(id, stub.requests(), ran.code);
    if (missed !== null) return missed;
    const records = await readProbeRecords(marker);
    const reported = records.filter((item) => item.model !== null && (item.event === 'SessionStart' || item.event === 'UserPromptSubmit')).map((item) => ({ source: item.event as string, model: item.model as string }));
    return actualModelVerdict(id, K8_MODELS.codex, modelRequests(stub.requests())[0]?.model ?? null, reported);
  });
}

/**
 * K8's probe plugin: chat.message's `model` and each assistant message's provider and model
 * (message.updated), written to the marker file; no text.
 */
export function actualModelPlugin(markerFile: string): string {
  return [
    '// Jevris certify probe (throwaway profile only): notes the model each turn reports.',
    "import { appendFileSync } from 'node:fs';",
    `const MARKER = ${JSON.stringify(markerFile)};`,
    'const note = (event, model, role) => {',
    "  if (typeof model !== 'string' || model.length === 0) return;",
    "  try { appendFileSync(MARKER, JSON.stringify({ event, model: model.slice(0, 160), role }) + '\\n'); } catch (error) {}",
    '};',
    "const joined = (provider, model) => (typeof provider === 'string' && provider.length > 0 ? `${provider}/${model}` : model);", // path-hygiene: allow a harness model id (provider/model), not a path
    'export const JevrisStubProbe = async () => ({',
    '  event: async ({ event }) => {',
    "    const info = event && event.type === 'message.updated' && event.properties ? event.properties.info : null;",
    "    if (info && info.role === 'assistant') note('message.updated', joined(info.providerID, info.modelID), 'assistant');",
    '  },',
    "  'chat.message': async (input) => {",
    "    const model = input && input.model && typeof input.model === 'object' ? input.model : null;",
    "    if (model) note('chat.message', joined(model.providerID, model.modelID), 'user');",
    '  },',
    '});',
    '',
  ].join('\n');
}

async function pluginActualModel(ctx: StubCaseContext, harness: PluginHarness): Promise<StubCaseResult> {
  const id = `${harness}.worker-actual-model`;
  return withStub(ctx, {}, async (stub, work) => {
    const profile = profileFor(ctx, stub, STUB_CASE_MODELS[harness]);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', `no stub profile for ${harness}`);
    const marker = join(work, `k8-${harness}.jsonl`);
    const file = join(work, `jevris-stub-probe-${id.replace(/[^a-z0-9-]/g, '-')}.mjs`);
    await rm(marker, { force: true });
    await writeFile(file, actualModelPlugin(marker));
    const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
    let config: { [key: string]: unknown };
    try {
      config = JSON.parse(profile.env[key] ?? '{}') as { [key: string]: unknown };
    } catch {
      return result(id, false, 'NO_STUB_PROFILE', 'the stub config did not parse');
    }
    const env = { ...profile.env, [key]: JSON.stringify({ ...config, plugin: [fileUrl(file)] }) };
    // The owned worker's own argv shape: `run --format json --model provider/model`.
    const ran = await ctx.cli.run(LAUNCHER[harness], ['run', '--format', 'json', '--model', K8_MODELS[harness], PROMPT], ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, env, { cwd: work });
    const missed = stubMiss(id, stub.requests(), ran.code);
    if (missed !== null) return missed;
    const records = await readProbeRecords(marker);
    const reported = records.filter((item) => item.model !== null && item.event !== null).map((item) => ({ source: item.event as string, model: item.model as string }));
    const agent = agentRequests(stub.requests())[0] ?? modelRequests(stub.requests())[0];
    return actualModelVerdict(id, K8_MODELS[harness], agent?.model ?? null, reported);
  });
}

/** K2: the model OD-6's actuator routes a Codex subagent to (a listed Codex model, not the session's). */
export const K2_MODELS = { session: STUB_CASE_MODELS.codex, routed: 'gpt-6-astra' } as const;
/** The file the subagent's scripted escalated shell call tries to write. */
export const K2_ESCAPE_FILE = 'jevris-k2-escape';
/** K2's spawn_agent call, as the stub scripts it for the parent (MultiAgentV2 takes no agent id). */
export const K2_SPAWN_INPUT: { readonly [key: string]: string } = { message: PROMPT, task_name: 'jevris_probe' };

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The answer the installed hook gives K2's spawn_agent call once hooks.route is certified: the
 * installed Codex adapter (this runtime's own) renders the route for exactly that call. Null when
 * it renders none, which fails the case.
 */
export function k2Route(): CodexProbeRoute | null {
  const fixture = codexAdapter.FIXTURES.find((item) => item.id === 'codex.pre-spawn-agent');
  if (fixture === undefined || !isRecord(fixture.native)) return null;
  const native = { ...fixture.native, model: K2_MODELS.session, tool_input: { ...K2_SPAWN_INPUT } };
  const normalized = codexAdapter.normalize(native);
  if (!normalized.ok) return null;
  const text = codexAdapter.protocolResponse(normalized.event, { kind: 'route', model: K2_MODELS.routed }, native);
  return text.length === 0 ? null : { input: { ...K2_SPAWN_INPUT }, text };
}

/**
 * The subagent's shell call for whichever shell tool Codex offers, or null when it offers none.
 * `escalate` asks to run it outside the sandbox, which needs the user's approval under `on-request`.
 */
export function codexShellCall(toolNames: readonly string[], command: string, escalate = false): StubReply | null {
  const ask = escalate ? { sandbox_permissions: 'require_escalated', justification: 'Jevris certify probe: must be declined' } : {};
  if (toolNames.includes('exec_command')) return { kind: 'tool', name: 'exec_command', input: { cmd: command, ...ask } };
  if (toolNames.includes('shell_command')) return { kind: 'tool', name: 'shell_command', input: { command, ...ask } };
  if (toolNames.includes('shell')) return { kind: 'tool', name: 'shell', input: { command: ['sh', '-c', command], ...ask } };
  return null;
}

/** K2's escalated write: the absolute path, single-quoted, so a subagent in another folder still writes where the case looks. */
export function k2WriteCommand(escapePath: string): string {
  return `echo x > '${escapePath.replace(/'/g, "'\\''")}'`;
}

/**
 * Where a request offers a tool: `{}` for a plain tool, `{ namespace }` for one inside a Responses
 * namespace (listed as `<namespace>.<tool>`), null when it is not offered. Codex 0.157.1 puts the
 * MultiAgentV2 tools under the `features.multi_agent_v2.tool_namespace` namespace ("collaboration"
 * by default) whenever the provider takes namespaced tools, which every configured provider does.
 */
export function offeredTool(toolNames: readonly string[], name: string): { readonly namespace?: string } | null {
  if (toolNames.includes(name)) return {};
  const suffix = `.${name}`;
  const namespaced = toolNames.find((item) => item.endsWith(suffix) && item.length > suffix.length);
  return namespaced === undefined ? null : { namespace: namespaced.slice(0, -suffix.length) };
}

/**
 * K2's stub script (MultiAgentV2 tools, which take no agent id): the parent spawns once, then waits
 * once, each call in the namespace the tool was offered in; a request on the routed model (the
 * subagent) makes one escalated shell call that writes `escapePath`.
 */
export function k2Script(escapePath: string): (request: StubRequest) => StubReply | undefined {
  let spawned = false;
  let waited = false;
  let wrote = false;
  return (request) => {
    if (request.model === K2_MODELS.routed) {
      if (wrote) return undefined;
      const call = codexShellCall(request.toolNames, k2WriteCommand(escapePath), true);
      if (call === null) return undefined;
      wrote = true;
      return call;
    }
    const spawn = offeredTool(request.toolNames, 'spawn_agent');
    if (!spawned && spawn !== null) {
      spawned = true;
      return { kind: 'tool', name: 'spawn_agent', input: { ...K2_SPAWN_INPUT }, ...spawn };
    }
    const wait = offeredTool(request.toolNames, 'wait_agent');
    if (spawned && !waited && wait !== null) {
      waited = true;
      return { kind: 'tool', name: 'wait_agent', input: { timeout_ms: 30_000 }, ...wait };
    }
    return undefined;
  };
}

/** One approval request Codex sent the client during K2's turn. */
export interface CodexApprovalRequest {
  readonly method: string;
  readonly threadId: string | null;
}

/** How K2's app-server turn went. */
export interface CodexAppServerRun {
  readonly spawned: boolean;
  /** `completed` when the parent turn completed (and, with awaitSubagent, every subagent turn); otherwise why the session stopped. */
  readonly ended: 'completed' | 'timeout' | 'protocol-error' | 'exited';
  readonly parentThreadId: string | null;
  readonly approvals: readonly CodexApprovalRequest[];
  /** A thread id's role in the trace: `parent`, `child-<n>` in the order first seen, or `none`. */
  readonly roleOf: (threadId: string | null) => string;
}

/** The client's answer to each approval request: always a refusal. */
const APPROVAL_ANSWERS: Readonly<Record<string, unknown>> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  execCommandApproval: { decision: 'denied' },
  applyPatchApproval: { decision: 'denied' },
};
/** Approval requests with no plain refusal value: answered with an error, which refuses them too. */
const APPROVAL_REFUSED_BY_ERROR: ReadonlySet<string> = new Set(['item/permissions/requestApproval']);

export interface CodexAppServerInput {
  readonly launch: typeof launchInteractive;
  readonly args: readonly string[];
  readonly env: { readonly [key: string]: string };
  readonly cwd: string;
  readonly model: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  /**
   * Wait for the subagents too: the session ends only once the parent turn and at least one
   * subagent thread's turn have completed, and every subagent thread seen has completed its turn.
   * A MultiAgentV2 spawn_agent returns at once and the child runs on its own thread, so the parent
   * can complete before the child's first tool call runs (Codex 0.157.1,
   * core/src/agent/control/spawn.rs; the owner's certify run, SHELL_NOT_SEEN).
   */
  readonly awaitSubagent?: boolean;
  /** Where the run notes, by name only, every message it sends and receives. */
  readonly trace?: StubTrace;
}

/**
 * One turn through `codex app-server` over stdio JSON-RPC: initialize, initialized, thread/start
 * (approval policy `on-request`, read-only sandbox, the probe hooks trusted for this thread only),
 * then turn/start. Every approval request Codex sends is noted and refused. It ends when the
 * parent turn completes (with awaitSubagent, once every subagent thread's turn has completed too),
 * the process exits, a request fails or the time runs out. App-server sends each spawned thread's
 * notifications and approval requests with that thread's id.
 */
export async function codexAppServerTurn(input: CodexAppServerInput): Promise<CodexAppServerRun> {
  let nextId = 1;
  let parentThreadId: string | null = null;
  const approvals: CodexApprovalRequest[] = [];
  let ended: CodexAppServerRun['ended'] | null = null;
  let session: InteractiveLaunch | null = null;
  let parentDone = false;
  // Each subagent thread seen, and whether its latest turn has completed.
  const children = new Map<string, boolean>();
  const roles = new Map<string, string>();
  const roleOf = (threadId: string | null): string => {
    if (threadId === null) return 'none';
    if (threadId === parentThreadId) return 'parent';
    let known = roles.get(threadId);
    if (known === undefined) {
      known = `child-${Math.min(roles.size + 1, 99)}`;
      roles.set(threadId, known);
    }
    return known;
  };
  const trace = input.trace;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const settle = (value: CodexAppServerRun['ended']): void => {
    if (ended !== null) return;
    ended = value;
    session?.endInput();
    session?.kill();
    finish();
  };
  const send = (message: unknown): void => {
    session?.send(`${JSON.stringify(message)}\n`);
  };
  const threadOf = (params: { readonly [key: string]: unknown }): string | null => (typeof params['threadId'] === 'string' ? params['threadId'] : typeof params['conversationId'] === 'string' ? params['conversationId'] : null);
  // Each request's method, noted before it is sent: an answer can arrive while send runs.
  const pending = new Map<number, string>();
  const request = (method: string, params: unknown): void => {
    const id = nextId;
    nextId += 1;
    pending.set(id, method);
    trace?.add('client', method, isRecord(params) ? roleOf(threadOf(params)) : 'none');
    send({ id, method, params });
  };
  const maybeSettle = (): void => {
    if (!parentDone) return;
    if (input.awaitSubagent === true && ![...children.values()].some((done) => done)) return;
    if ([...children.values()].every((done) => done)) settle('completed');
  };
  // A MultiAgentV2 spawn is announced on the parent's thread as a subAgentActivity item carrying
  // the child's thread id, and its end as another with kind `completed` (Codex 0.157.1,
  // multi_agents_v2/spawn.rs and agent/control/completion.rs).
  const noteSubagent = (item: { readonly [key: string]: unknown }): void => {
    const child = item['agentThreadId'];
    if (item['type'] !== 'subAgentActivity' || typeof child !== 'string' || child.length === 0 || child === parentThreadId) return;
    roleOf(child);
    if (item['kind'] === 'completed') children.set(child, true);
    else if (!children.has(child)) children.set(child, false);
    maybeSettle();
  };
  const noteThread = (thread: string | null, method: string): void => {
    if (thread === null || parentThreadId === null) return;
    if (thread === parentThreadId) {
      if (method === 'turn/completed') parentDone = true;
      else if (method === 'turn/started') parentDone = false;
    } else if (method === 'turn/completed') children.set(thread, true);
    else if (method === 'turn/started' || !children.has(thread)) children.set(thread, false);
    maybeSettle();
  };
  const onLine = (line: string): void => {
    if (ended !== null) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // a log line
    }
    if (!isRecord(message)) return;
    const method = typeof message['method'] === 'string' ? message['method'] : null;
    const id = message['id'];
    const params = isRecord(message['params']) ? message['params'] : {};
    if (method !== null && (typeof id === 'number' || typeof id === 'string')) {
      const thread = threadOf(params);
      trace?.add('server', method, roleOf(thread));
      const answer = APPROVAL_ANSWERS[method];
      if (answer !== undefined || APPROVAL_REFUSED_BY_ERROR.has(method)) approvals.push({ method, threadId: thread });
      if (answer !== undefined) send({ id, result: answer });
      else send({ id, error: { code: -32601, message: 'not supported by jevris certify' } });
      trace?.add('client', answer !== undefined ? `answer:${method}` : `refuse:${method}`, roleOf(thread));
      noteThread(thread, method);
      return;
    }
    if (method !== null) {
      const thread = typeof params['threadId'] === 'string' ? params['threadId'] : null;
      const item = isRecord(params['item']) ? params['item'] : null;
      const itemType = item !== null && typeof item['type'] === 'string' ? item['type'] : null;
      const kind = item !== null && itemType === 'subAgentActivity' && typeof item['kind'] === 'string' ? `:${item['kind']}` : '';
      trace?.add('server', itemType === null ? method : `${method}:${itemType}${kind}`, roleOf(thread));
      if (item !== null) noteSubagent(item);
      noteThread(thread, method);
      return;
    }
    const answered = typeof id === 'number' ? pending.get(id) : undefined;
    if (answered === undefined) return;
    pending.delete(id as number);
    trace?.add('server', `${message['error'] !== undefined ? 'error' : 'result'}:${answered}`, 'none');
    if (message['error'] !== undefined) {
      settle('protocol-error');
      return;
    }
    if (answered === 'initialize') {
      trace?.add('client', 'initialized', 'none');
      send({ method: 'initialized' });
      request('thread/start', { model: input.model, cwd: input.cwd, approvalPolicy: 'on-request', sandbox: 'read-only', config: { bypass_hook_trust: true } });
      return;
    }
    if (answered === 'thread/start') {
      const result = message['result'];
      const thread = isRecord(result) && isRecord(result['thread']) ? result['thread']['id'] : null;
      if (typeof thread !== 'string' || thread.length === 0) {
        settle('protocol-error');
        return;
      }
      parentThreadId = thread;
      request('turn/start', { threadId: thread, input: [{ type: 'text', text: input.prompt, text_elements: [] }] });
    }
  };
  session = input.launch(LAUNCHER.codex, input.args, { cwd: input.cwd, env: input.env, onLine });
  if (session.pid === undefined) {
    await session.done;
    return { spawned: false, ended: 'exited', parentThreadId: null, approvals: [], roleOf };
  }
  const timer = setTimeout(() => settle('timeout'), input.timeoutMs);
  void session.done.then(() => settle('exited'));
  request('initialize', { clientInfo: { name: 'jevris', title: 'Jevris', version: '1' } });
  await finished;
  clearTimeout(timer);
  await session.done;
  const outcome = ended as CodexAppServerRun['ended'] | null;
  trace?.add('client', `ended:${outcome ?? 'exited'}`, 'none');
  return { spawned: true, ended: outcome ?? 'exited', parentThreadId, approvals, roleOf };
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function definedEnv(env: { readonly [key: string]: string | undefined }): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

async function codexSubagentRoute(ctx: StubCaseContext): Promise<StubCaseResult> {
  const id = 'codex.subagent-route';
  const route = k2Route();
  if (route === null) return result(id, false, 'ROUTE_NOT_RENDERED', "the installed Codex adapter rendered no route for K2's spawn_agent call");
  // withStub's work folder, known before the stub starts so the script can name the file.
  const escape = join(ctx.profile, 'jevris-stub-case', K2_ESCAPE_FILE);
  // The case's trace (coordinator's decision after the owner's RC5 run): names and thread roles
  // only, so a failure on a real binary can be read from the evidence without a paste.
  const trace = createStubTrace();
  const scripted = k2Script(escape);
  let listed = false;
  const script = (request: StubRequest): StubReply | undefined => {
    const role = request.model === K2_MODELS.routed ? 'routed' : request.model === K2_MODELS.session ? 'session' : 'other';
    trace.add('stub', `request:${role}`, 'none');
    if (request.headerNames.includes('x-openai-subagent')) trace.add('stub', 'header:x-openai-subagent', 'none');
    if (role !== 'session') {
      // The first subagent request's whole tool list, then only whether exec_command was offered.
      if (!listed) for (const tool of request.toolNames.slice(0, 48)) trace.add('stub', `offers:${tool}`, 'none');
      else trace.add('stub', request.toolNames.includes('exec_command') ? 'offers:exec_command' : 'offers:no-exec_command', 'none');
      listed = true;
    }
    const reply = scripted(request);
    trace.add('stub', reply === undefined ? 'reply:text' : reply.kind === 'tool' ? `reply:${reply.namespace === undefined ? '' : `${reply.namespace}.`}${reply.name}` : `reply:${reply.kind}`, 'none');
    return reply;
  };
  let roleOf: (threadId: string | null) => string = () => 'none';
  let markerFile: string | null = null;
  const traced = async (found: StubCaseResult): Promise<StubCaseResult> => {
    if (markerFile !== null) for (const item of await readProbeRecords(markerFile)) trace.add('hook', `${item.event ?? 'unknown'}:${item.tool ?? '-'}`, item.agent === null || item.agent === undefined ? 'parent' : roleOf(item.agent));
    return { ...found, trace: trace.entries() };
  };
  return withCodexProfile(ctx, id, { script }, K2_MODELS.session, async (stub, work, profile) => traced(await k2Judge(stub, work, profile)));

  async function k2Judge(stub: StubProvider, work: string, profile: StubProfile): Promise<StubCaseResult> {
    const marker = join(work, 'k2-codex.jsonl');
    markerFile = marker;
    const probe = join(work, 'k2-codex-probe.cjs');
    await rm(marker, { force: true });
    await rm(escape, { force: true });
    await writeFile(probe, codexProbeHook(marker, route));
    // The app-server, not exec: exec runs every turn with approval "never", which cannot show
    // that an allow leaves the approval prompt in place.
    const args = ['-c', 'check_for_update_on_startup=false', '-c', 'features.multi_agent_v2=true', ...codexProbeConfig(probe), 'app-server'];
    const run = await codexAppServerTurn({ launch: ctx.launchInteractive ?? launchInteractive, args, env: definedEnv(profile.env), cwd: work, model: K2_MODELS.session, prompt: PROMPT, timeoutMs: ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, awaitSubagent: true, trace });
    roleOf = run.roleOf;
    if (!run.spawned) return result(id, false, 'HARNESS_NOT_STARTED', 'codex app-server did not start');
    if (run.ended === 'protocol-error') return result(id, false, 'APP_SERVER_REFUSED', 'codex app-server refused initialize, thread/start or turn/start');
    const missed = stubMiss(id, stub.requests(), run.ended === 'completed' ? 0 : 1);
    if (missed !== null) return missed;
    const requests = modelRequests(stub.requests());
    if (!requests.some((item) => offeredTool(item.toolNames, 'spawn_agent') !== null)) return result(id, false, 'NO_SPAWN_TOOL', `no request offered spawn_agent, plain or in a tool namespace (turn ${run.ended})`);
    const records = await readProbeRecords(marker);
    const spawns = records.filter((item) => item.event === 'PreToolUse' && codexAdapter.isSpawnHookName(item.tool));
    if (spawns.length === 0) {
      // Codex names a namespaced call `<namespace>spawn_agent` in the hook (core/src/tools/registry.rs,
      // function_hook_tool_name), except in the default and multi_agent_v1 namespaces. The adapter
      // reads only the default MultiAgentV2 namespace's name as spawn_agent (owner decision 0a9dc8c).
      const renamed = records.find((item) => item.event === 'PreToolUse' && item.tool !== null && item.tool.endsWith('spawn_agent'));
      if (renamed !== undefined) return result(id, false, 'SPAWN_HOOK_NAME_NAMESPACED', `Codex gave PreToolUse the spawn call as "${renamed.tool}", a tool-namespace name the installed adapter does not route (it routes ${codexAdapter.SPAWN_HOOK_NAMES.map((name) => `"${name}"`).join(' and ')})`);
      return result(id, false, 'HOOK_NOT_RUN', 'the probe PreToolUse hook never saw the spawn_agent call');
    }
    const hookName = spawns.find((item) => item.answered)?.tool ?? spawns[0]?.tool ?? 'spawn_agent';
    if (!spawns.some((item) => item.answered)) return result(id, false, 'SPAWN_INPUT_UNEXPECTED', "the spawn_agent input Codex gave the hook was not the scripted call, so the probe gave no route");
    const routed = requests.filter((item) => item.model === K2_MODELS.routed);
    if (routed.length === 0) {
      const models = [...new Set(requests.map((item) => item.model ?? 'no model'))].join(', ');
      return result(id, false, 'ROUTE_IGNORED', `no subagent request carried ${K2_MODELS.routed} (requests: ${models}): spawn_agent's updatedInput.model with allow was not honoured`);
    }
    if (await exists(escape)) return result(id, false, 'ALLOW_SKIPPED_APPROVAL', "the subagent's escalated write ran although every approval request was declined: an allow skipped a native check");
    if (!records.some((item) => item.event === 'PreToolUse' && item.tool === 'Bash')) return result(id, false, 'SHELL_NOT_SEEN', `the subagent made no shell call the hook saw (turn ${run.ended}), so the approval half is unproven`);
    const asked = run.approvals.filter((item) => item.method !== 'item/fileChange/requestApproval' && item.method !== 'applyPatchApproval');
    if (asked.length === 0) return result(id, false, 'APPROVAL_NOT_ASKED', `the subagent's escalated shell call reached no approval request under on-request (turn ${run.ended})`);
    const threads = asked.some((item) => item.threadId !== null && item.threadId !== run.parentThreadId) ? "on the subagent's thread" : 'on the parent thread';
    return result(
      id,
      true,
      null,
      `the installed adapter's allow plus updatedInput.model, on the ${hookName} call, ran the subagent on ${K2_MODELS.routed} while the session ran ${K2_MODELS.session}; under on-request the subagent's escalated write still asked for approval (${asked.length} request(s), ${threads}) and, declined, did not run`,
    );
  }
}

/** K13 to K15: the session's model through a gateway, and the model a probe routes to on the same gateway. */
export const HOST_CASE = { provider: 'openrouter', session: 'moonshotai/kimi-k3', routed: 'z-ai/glm-5.3' } as const;
/** The harness spellings of HOST_CASE's two models (provider/model ids, not paths). */
const HOST_SESSION = [HOST_CASE.provider, HOST_CASE.session].join('/');
const HOST_ROUTED = [HOST_CASE.provider, HOST_CASE.routed].join('/');
/** The stub path the global config's gateway uses, and the one a project config redefines it to (K15). */
export const HOST_CASE_PATHS = { global: 'openrouter', project: 'project-openrouter' } as const;

/** A gateway provider entry for the inline or project config, pointed at the stub under `prefix`. */
function hostProvider(stub: StubProvider, prefix: string, models: readonly string[]): { readonly [key: string]: unknown } {
  return {
    npm: '@openrouter/ai-sdk-provider',
    options: { baseURL: `${stub.baseUrl}/${prefix}/v1`, apiKey: stub.dummyKey }, // path-hygiene: allow loopback URL, not a file path
    models: Object.fromEntries(models.map((model) => [model, { name: model }])),
  };
}

/**
 * The host route probe plugin (K14, K15): chat.message of a top-level session sets
 * output.message.model to HOST_CASE.routed on HOST_CASE.provider, except on a message carrying
 * UNROUTED_MARK. At load it writes the `directory` and `worktree` the harness gave it to `rootsFile`.
 */
export function hostRouteProbePlugin(rootsFile: string): string {
  return [
    '// Jevris certify probe (throwaway profile only): routes one turn within a gateway.',
    "import { writeFileSync } from 'node:fs';",
    'export const JevrisStubProbe = async (context) => {',
    `  try { writeFileSync(${JSON.stringify(rootsFile)}, JSON.stringify({ directory: context && context.directory, worktree: context && context.worktree })); } catch (error) {}`,
    '  const children = new Set();',
    '  return {',
    '    event: async ({ event }) => {',
    "      if (event && event.type === 'session.created' && event.properties && event.properties.info && event.properties.info.parentID) children.add(event.properties.info.id);",
    '    },',
    "    'chat.message': async (input, output) => {",
    '      if (children.has(input && input.sessionID)) return;',
    '      const parts = output && Array.isArray(output.parts) ? output.parts : [];',
    `      if (parts.some((part) => part && typeof part.text === 'string' && part.text.includes(${JSON.stringify(UNROUTED_MARK)}))) return;`,
    `      if (output && output.message) output.message.model = { providerID: ${JSON.stringify(HOST_CASE.provider)}, modelID: ${JSON.stringify(HOST_CASE.routed)} };`,
    '    },',
    '  };',
    '};',
    '',
  ].join('\n');
}

/** The most the probe's roots file may hold. */
const ROOTS_FILE_CAP = 4096;

/**
 * The installed adapter's project config guard (the same source the shim is built from), run on
 * the directory the harness gave the probe plugin: true when it allows a route to `provider`,
 * false when it refuses. The directory must resolve inside the case folder, and the guard climbs
 * no higher than the case folder (B's LOW 23: outside a git repository OpenCode reports the
 * worktree as `/`, and certify reads nothing outside its throwaway profile). `unrecorded` when the
 * roots file is missing, not a regular file, over 4 KiB or unreadable; `outside` when the
 * directory is not inside the case folder.
 */
export async function guardAllowsAt(harness: PluginHarness, rootsFile: string, caseFolder: string, provider: string): Promise<boolean | 'unrecorded' | 'outside'> {
  let directory: unknown;
  try {
    const stat = await lstat(rootsFile);
    if (!stat.isFile() || stat.size > ROOTS_FILE_CAP) return 'unrecorded';
    directory = (JSON.parse(await readFile(rootsFile, 'utf8')) as { readonly directory?: unknown }).directory;
  } catch {
    return 'unrecorded';
  }
  if (typeof directory !== 'string' || !isAbsolute(directory)) return 'unrecorded';
  let inside: string;
  let top: string;
  try {
    [inside, top] = [await realpath(directory), await realpath(caseFolder)];
  } catch {
    return 'outside';
  }
  const rel = relative(top, inside);
  if (rel.startsWith('..') || isAbsolute(rel)) return 'outside';
  return projectConfigGuard(harness, { directory: inside, worktree: top }, nodeConfigHost)(provider);
}

function onPath(request: StubRequest, prefix: string): boolean {
  return request.path.startsWith(`/${prefix}/`);
}

/**
 * K14 and K15: two turns in one session on HOST_CASE.session through the global config's gateway,
 * the first routed by the probe to HOST_CASE.routed. K15 first writes a project config in its own
 * folder that redefines the gateway.
 */
async function hostRoute(ctx: StubCaseContext, harness: PluginHarness, redefined: boolean): Promise<StubCaseResult> {
  const id = `${harness}.session-route-host${redefined ? '-redefined' : ''}`;
  return withStub(ctx, {}, async (stub, shared) => {
    const profile = profileFor(ctx, stub, STUB_CASE_MODELS[harness]);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', `no stub profile for ${harness}`);
    // A folder of its own, so K15's project config never reaches another case.
    const work = join(shared, redefined ? 'host-redefined' : 'host');
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const plugin = join(work, 'jevris-stub-probe-host.mjs');
    const roots = join(work, 'jevris-stub-probe-roots.json');
    await writeFile(plugin, hostRouteProbePlugin(roots));
    const models = [HOST_CASE.session, HOST_CASE.routed];
    if (redefined) {
      const file = projectConfigFiles(harness, work, join)[0];
      if (file === undefined) return result(id, false, 'NO_PROJECT_CONFIG', `no project config file name for ${harness}`);
      await writeFile(file, JSON.stringify({ provider: { [HOST_CASE.provider]: hostProvider(stub, HOST_CASE_PATHS.project, models) } }));
    }
    const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
    let config: { [key: string]: unknown };
    try {
      config = JSON.parse(profile.env[key] ?? '{}') as { [key: string]: unknown };
    } catch {
      return result(id, false, 'NO_STUB_PROFILE', 'the stub config did not parse');
    }
    const session = HOST_SESSION;
    const provider = { ...((config['provider'] ?? {}) as { [key: string]: unknown }), [HOST_CASE.provider]: hostProvider(stub, HOST_CASE_PATHS.global, models) };
    const env = { ...profile.env, [key]: JSON.stringify({ ...config, provider, model: session, small_model: session, plugin: [fileUrl(plugin)] }) };
    const timeout = ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS;
    const ran = await ctx.cli.run(LAUNCHER[harness], ['run', '--format', 'json', PROMPT], timeout, env, { cwd: work });
    const missed = stubMiss(id, stub.requests(), ran.code);
    if (missed !== null) return missed;
    const firstTurn = stub.requests().length;
    await ctx.cli.run(LAUNCHER[harness], ['run', '--continue', '--format', 'json', FOLLOW_UP_PROMPT], timeout, env, { cwd: work });
    const allows = await guardAllowsAt(harness, roots, work, HOST_CASE.provider);
    if (allows === 'unrecorded') return result(id, false, 'ROOTS_NOT_RECORDED', 'the probe plugin did not record the directory the harness gave it');
    if (allows === 'outside') return result(id, false, 'ROOTS_OUTSIDE_CASE', "the directory the harness gave the plugin is not inside the case's folder");
    const first = agentRequests(stub.requests().slice(0, firstTurn))[0];
    if (redefined) {
      if (allows) return result(id, false, 'ROUTE_NOT_REFUSED', `the installed adapter's guard allowed a route to ${HOST_CASE.provider} although the project config in the session's folder redefines it (T-R6)`);
      const honoured = first !== undefined && onPath(first, HOST_CASE_PATHS.project) ? `; ${harness} itself sent the session's turn to the project's ${HOST_CASE.provider}, so the redefinition is live on this binary` : '';
      return result(id, true, null, `the installed adapter's guard refused a route to ${HOST_CASE.provider}, which a project config in the session's folder redefines${honoured}`);
    }
    if (first === undefined) return result(id, false, 'NO_AGENT_REQUEST', 'no agent request (one that offers tools) reached the stub');
    if (!onPath(first, HOST_CASE_PATHS.global)) return result(id, false, 'ROUTE_LEFT_HOST', `the routed turn reached ${first.path}, not the ${HOST_CASE.provider} provider the session used`);
    if (first.model !== HOST_CASE.routed) return result(id, false, 'ROUTE_IGNORED', `the turn ran on ${first.model ?? 'no model'}, not the ${HOST_CASE.routed} the probe set in chat.message`);
    const next = agentRequests(stub.requests().slice(firstTurn))[0];
    if (next === undefined) return result(id, false, 'SECOND_TURN_NOT_RUN', 'the second, unrouted turn of the session sent no agent request');
    if (!onPath(next, HOST_CASE_PATHS.global) || next.model !== HOST_CASE.session) return result(id, false, 'ROUTE_STUCK', `the next, unrouted turn ran on ${next.model ?? 'no model'} at ${next.path}, not the session's ${session}`);
    if (!allows) return result(id, false, 'GUARD_REFUSED', `the installed adapter's guard refused a route to ${HOST_CASE.provider} in a folder with no project config`);
    return result(id, true, null, `output.message.model moved the turn from ${session} to ${HOST_ROUTED} on the same provider, the stub saw ${first.model}, the next turn ran on ${HOST_CASE.session}, and the installed adapter's guard allows the route there`);
  });
}

/** K13's providers: the gateway and host lines, including a `:free` line and a `~` line the resolver drops. */
export const K13_LINES: Readonly<Record<PluginHarness, { readonly [provider: string]: readonly string[] }>> = {
  opencode: { openrouter: ['moonshotai/kimi-k3', 'moonshotai/kimi-k3:free'], nvidia: ['moonshotai/kimi-k3'] },
  kilocode: { openrouter: ['moonshotai/kimi-k3', 'moonshotai/kimi-k3:free'], kilo: ['moonshotai/kimi-k3', 'z-ai/glm-5.3', '~deepseek/deepseek-v4-flash-latest'], nvidia: ['moonshotai/kimi-k3'] },
};

/**
 * K13's registry: the bundled one plus the pinned hosts and exact servings the K13 lines use, as
 * serving hosts section 7 lists them. It judges the case only; it is never a routing registry.
 */
export function k13Registry(base: ModelRegistry = BUNDLED_MODEL_REGISTRY): ModelRegistry {
  const kimi = base.entries.find((entry) => entry.modelId === 'kimi-k3');
  const tariff = kimi === undefined ? null : { ...kimi.tariff, version: 'k13-certify', sourceId: 'K13-CERTIFY' };
  const row = (harness: PluginHarness, host: string) => ({ harness, host, segment: host, signIns: ['api-key' as const], sourceIds: ['K13-CERTIFY'] });
  const serving = (host: string, provider: string, modelId: string, hostModelId: string) => ({ host, provider, modelId, hostModelId, tariff, tariffBasis: tariff === null ? ('unknown' as const) : ('host' as const), sourceIds: ['K13-CERTIFY'] });
  return {
    ...base,
    harnessHosts: [row('opencode', 'openrouter'), row('opencode', 'nvidia'), row('kilocode', 'openrouter'), row('kilocode', 'kilo'), row('kilocode', 'nvidia')],
    servings: [
      serving('openrouter', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
      serving('kilo', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
      serving('kilo', 'zai', 'glm-5.3', 'z-ai/glm-5.3'),
      serving('nvidia', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
    ],
  } as ModelRegistry;
}

/** The lines K13 must keep, each on its own host: K13_LINES without the `:free` and `~` lines. */
export function k13Expected(harness: PluginHarness): readonly { readonly raw: string; readonly servingHost: string }[] {
  return Object.entries(K13_LINES[harness]).flatMap(([provider, models]) => models.filter((model) => !model.includes(':free') && !model.startsWith('~')).map((model) => ({ raw: [provider, model].join('/'), servingHost: provider })));
}

/**
 * K13's verdict on the listing's output, parsed as the model listing parses it but with
 * k13Registry: every expected gateway or host line is kept as its own spelling on its own host
 * (the NVIDIA line as evidence; consent keeps it from routing), and no `:free` or `~` line is
 * kept. Only the parsed spellings are used; the output text is dropped.
 */
export function k13Verdict(id: string, harness: PluginHarness, ran: { readonly spawned: boolean; readonly code: number; readonly stdout: string }): StubCaseResult {
  if (!ran.spawned) return result(id, false, 'HARNESS_NOT_STARTED', `${harness} models did not start`);
  if (ran.code !== 0) return result(id, false, 'LISTING_FAILED', `${harness} models exited ${ran.code}`);
  if (ran.stdout.length > LISTING_STDOUT_CAP) return result(id, false, 'LISTING_TOO_LARGE', `${harness} models printed more than ${LISTING_STDOUT_CAP} bytes`);
  const parsed = parseProviderListing(ran.stdout, harness, k13Registry());
  if (parsed === null) return result(id, false, 'LISTING_MALFORMED', `${harness} models printed a line that is not provider/model`);
  const spellings = parsed.spellings;
  const missing = k13Expected(harness).find((want) => !spellings.some((item) => item.raw === want.raw && item.servingHost === want.servingHost));
  if (missing !== undefined) return result(id, false, 'HOST_LINE_NOT_KEPT', `the listing kept ${spellings.length} spelling(s), not ${missing.raw} on ${missing.servingHost}`);
  const wrong = spellings.filter((item) => item.raw.includes(':free') || item.raw.includes('/~'));
  if (wrong.length > 0) return result(id, false, 'HOST_LINE_KEPT_WRONGLY', `kept ${wrong.map((item) => item.raw).join(', ')}, a free or moving line`);
  return result(id, true, null, `the listing kept ${spellings.map((item) => `${item.raw} (${item.servingHost})`).join(', ')} (the NVIDIA line as evidence only), and no free or moving line`);
}

/**
 * K13: the harness's own listing (the command and no-update variables the model listing uses)
 * with the K13 providers in the inline config, pointed at the stub with the dummy key. No model
 * runs.
 */
async function modelsListHosts(ctx: StubCaseContext, harness: PluginHarness): Promise<StubCaseResult> {
  const id = `${harness}.models-list-hosts`;
  return withStub(ctx, {}, async (stub, work) => {
    const profile = profileFor(ctx, stub, STUB_CASE_MODELS[harness]);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', `no stub profile for ${harness}`);
    const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
    let config: { [key: string]: unknown };
    try {
      config = JSON.parse(profile.env[key] ?? '{}') as { [key: string]: unknown };
    } catch {
      return result(id, false, 'NO_STUB_PROFILE', 'the stub config did not parse');
    }
    const hosts = Object.fromEntries(Object.entries(K13_LINES[harness]).map(([provider, models]) => [provider, hostProvider(stub, provider, models)]));
    const env = { ...profile.env, [key]: JSON.stringify({ ...config, provider: { ...((config['provider'] ?? {}) as { [key: string]: unknown }), ...hosts } }) };
    const ran = await ctx.cli.run(LAUNCHER[harness], listingArgv(harness) ?? ['models'], Math.min(ctx.timeoutMs ?? STUB_CASE_TIMEOUT_MS, LISTING_TIMEOUT_MS), listingEnv(harness, env), { cwd: work });
    return k13Verdict(id, harness, ran);
  });
}

/** The harnesses with access-limit cases (K16-K18): every one with a custom endpoint. */
export type AccessCaseHarness = 'claude' | 'codex' | 'opencode' | 'kilocode';
export type AccessCaseKind = 'rate' | 'credit' | 'auth';

/** The class each access-limit case must reach. */
export const ACCESS_CASE_CLASS: Readonly<Record<AccessCaseKind, AccessLimitClass>> = { rate: 'rate-limit', credit: 'credit-exhausted', auth: 'account-blocked' };

/**
 * The fixed time bound of one access case run (design 6.2: the harness's own retries are waited
 * out inside it, with `retry-after: 1`). A run still going at the bound fails the case; a timeout
 * is never read as a pass.
 */
export const ACCESS_CASE_TIMEOUT_MS = 60_000;

/** The bound one access case runs under: ACCESS_CASE_TIMEOUT_MS, or a shorter one a test gives. */
function accessBound(ctx: StubCaseContext): number {
  return Math.min(ctx.timeoutMs ?? ACCESS_CASE_TIMEOUT_MS, ACCESS_CASE_TIMEOUT_MS);
}

/** A run that hit the case's bound (certify's run exits 124 at its deadline). */
function keptRetrying(id: string, ran: { readonly code: number }, boundMs: number): StubCaseResult | null {
  return ran.code === 124 ? result(id, false, 'HARNESS_KEPT_RETRYING', `the run was still going at the case's ${Math.round(boundMs / 1000)} s bound (the harness kept retrying), so it is not a pass`) : null;
}

/** Text in every scripted error body and header: a case fails if it shows up in anything Jevris keeps. */
export const ACCESS_CANARY = 'JEVRIS-ACCESS-CANARY-5d1c';

/** The access.session case of each harness that has one (K19, K20). */
export const ACCESS_SESSION_CASES: Readonly<Partial<Record<GlobalHarness, string>>> = {
  claude: 'claude.session.stop-failure',
  kilocode: 'kilocode.session.error',
  opencode: 'opencode.session.error',
};

/** The access.detect case ids of one harness (K16, K17, K18). */
export function accessDetectCaseIds(harness: AccessCaseHarness): readonly string[] {
  return (['rate', 'credit', 'auth'] as const).map((kind) => `${harness}.access-limit.${kind}`);
}

/**
 * The scripted error for one case, in the API's own shape (Anthropic Messages for Claude Code,
 * Kilo and OpenCode; OpenAI Responses for Codex). The bodies follow each provider's documented
 * error objects; the canary rides in the message and in a header.
 */
export function accessErrorReply(api: 'anthropic' | 'openai', kind: AccessCaseKind, nowMs: number): StubReply {
  const canary = { 'x-jevris-canary': ACCESS_CANARY };
  const halfHour = nowMs + 30 * 60_000;
  if (api === 'anthropic') {
    if (kind === 'rate') return { kind: 'error', status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: `This request would exceed the rate limit for your organization. ${ACCESS_CANARY}` } }, headers: { ...canary, 'retry-after': '1', 'anthropic-ratelimit-requests-reset': new Date(halfHour).toISOString() } };
    if (kind === 'credit') return { kind: 'error', status: 402, body: { type: 'error', error: { type: 'billing_error', message: `Your credit balance is too low to access the Anthropic API. ${ACCESS_CANARY}` } }, headers: canary };
    return { kind: 'error', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${ACCESS_CANARY}` } }, headers: canary };
  }
  if (kind === 'rate') return { kind: 'error', status: 429, body: { error: { message: `Rate limit reached for requests. ${ACCESS_CANARY}`, type: 'requests', param: null, code: 'rate_limit_exceeded' } }, headers: { ...canary, 'retry-after': '1', 'x-ratelimit-reset-requests': '30m0s' } };
  if (kind === 'credit') return { kind: 'error', status: 429, body: { error: { message: `You exceeded your current quota, please check your plan and billing details. ${ACCESS_CANARY}`, type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }, headers: canary };
  return { kind: 'error', status: 401, body: { error: { message: `Incorrect API key provided. ${ACCESS_CANARY}`, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }, headers: canary };
}

/** A stub script that answers every model request with the case's error (a count or listing request is answered as usual). */
function errorScript(api: 'anthropic' | 'openai', kind: AccessCaseKind): (request: StubRequest) => StubReply | undefined {
  return (request) => (modelRequests([request]).length === 1 ? accessErrorReply(api, kind, Date.now()) : undefined);
}

/** A signal as a case may print it: its channel, codes and pattern id (never text). */
export function describeSignal(signal: AccessSignalWire): string {
  const parts = [
    signal.channel,
    ...(signal.errorType === undefined ? [] : [signal.errorType]),
    ...(signal.status === undefined ? [] : [`status ${signal.status}`]),
    ...(signal.errorCode === undefined ? [] : [`code ${signal.errorCode}`]),
    ...(signal.rateLimitType === undefined ? [] : [signal.rateLimitType]),
    ...(signal.text === undefined ? [] : [`pattern ${signal.text.pattern}`]),
  ];
  return parts.join(', ');
}

/** The transcript's signal, read by the harness's owned-worker parser. */
function transcriptSignal(harness: AccessCaseHarness, ran: { readonly code: number; readonly stdout: string; readonly stderr?: string }, nowMs: number): AccessSignalWire | null {
  if (harness === 'claude') return claudeTranscriptAccess(ran.stdout, nowMs);
  if (harness === 'codex') return codexTranscriptAccess(ran.stdout, ran.stderr ?? '', ran.code, nowMs);
  return opencodeTranscriptAccess(ran.stdout, harness, nowMs);
}

/**
 * K16-K18's verdict on one run: the port's parser must find a signal, core (with the case's own
 * proof, so certified) must give it the case's class, and no canary text may reach the signal or
 * the finding. K16 on Kilo and OpenCode must also carry the reset their error's headers give.
 */
export function accessVerdict(id: string, harness: AccessCaseHarness, kind: AccessCaseKind, ran: { readonly spawned: boolean; readonly code: number; readonly stdout: string; readonly stderr?: string }, nowMs: number, boundMs: number = ACCESS_CASE_TIMEOUT_MS): StubCaseResult {
  if (!ran.spawned) return result(id, false, 'HARNESS_NOT_STARTED', `${harness} did not start`);
  const timedOut = keptRetrying(id, ran, boundMs);
  if (timedOut !== null) return timedOut;
  const signal = transcriptSignal(harness, ran, nowMs);
  if (signal === null) return result(id, false, 'NO_ACCESS_SIGNAL', `the run's transcript gave the port no access signal (exit ${ran.code})`);
  const access = classifyAccessSignal({ ...signal, certified: true }, 'api-key', nowMs);
  if (JSON.stringify({ signal, access }).includes(ACCESS_CANARY)) return result(id, false, 'CANARY_KEPT', 'text from the scripted error reached the signal or the finding');
  const want = ACCESS_CASE_CLASS[kind];
  if (access === null) return result(id, false, 'NOT_CLASSIFIED', `the signal (${describeSignal(signal)}) matched no row`);
  if (access.class !== want) return result(id, false, 'WRONG_CLASS', `row ${access.signal} gave ${access.class}, not ${want} (${describeSignal(signal)})`);
  const headerReset = kind === 'rate' && (harness === 'opencode' || harness === 'kilocode');
  if (headerReset && access.reportedResetMs === null) return result(id, false, 'RESET_NOT_PARSED', `row ${access.signal} gave ${want}, but the error's reset headers gave no reset`);
  return result(id, true, null, `row ${access.signal} gave ${want} (${describeSignal(signal)}${access.reportedResetMs === null ? '' : '; reset parsed'})`);
}

/**
 * The retry count Claude Code's access cases run with: one retry, so a retried 429 or 401 ends
 * the turn well inside the case's bound. The documented variable (code.claude.com/docs/en/env-vars,
 * CLAUDE_CODE_MAX_RETRIES, default 10) is a number of retry attempts; 1 is used rather than 0,
 * which the docs do not define. CLAUDE_CODE_RETRY_WATCHDOG, which retries 429s indefinitely, is
 * removed from the case's environment.
 */
export const CLAUDE_CASE_MAX_RETRIES = '1';

/** The environment of a Claude Code access case (K16-K19): the stub profile's, with the retry cap. */
export function claudeAccessEnv(env: { readonly [key: string]: string | undefined }): { [key: string]: string | undefined } {
  const out: { [key: string]: string | undefined } = { ...env, CLAUDE_CODE_MAX_RETRIES: CLAUDE_CASE_MAX_RETRIES };
  delete out['CLAUDE_CODE_RETRY_WATCHDOG'];
  return out;
}

/** One K16-K18 run: the harness's own non-interactive turn, as its owned worker starts one, against the scripted error. */
async function accessLimitCase(ctx: StubCaseContext, harness: AccessCaseHarness, kind: AccessCaseKind): Promise<StubCaseResult> {
  const id = `${harness}.access-limit.${kind}`;
  const timeout = accessBound(ctx);
  if (harness === 'codex') {
    // Codex's documented per-provider retry count (default 4), so the error ends the turn in time.
    const retries = ['--config', `model_providers.${CODEX_STUB_PROVIDER}.request_max_retries=0`, '--config', `model_providers.${CODEX_STUB_PROVIDER}.stream_max_retries=0`];
    return withCodexProfile(ctx, id, { script: errorScript('openai', kind) }, STUB_CASE_MODELS.codex, async (stub, work, profile) => {
      const ran = await ctx.cli.run(LAUNCHER.codex, [...codexExecArgs(STUB_CASE_MODELS.codex, 'read-only'), ...retries, PROMPT], timeout, profile.env, { cwd: work });
      return stubMiss(id, stub.requests(), ran.code) ?? accessVerdict(id, harness, kind, ran, Date.now(), timeout);
    });
  }
  return withStub(ctx, { script: errorScript('anthropic', kind) }, async (stub, work) => {
    const profile = profileFor(ctx, stub, STUB_CASE_MODELS[harness]);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', `no stub profile for ${harness}`);
    const args = harness === 'claude' ? ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', '1', '--model', STUB_CASE_MODELS.claude, PROMPT] : ['run', '--format', 'json', PROMPT];
    const ran = await ctx.cli.run(LAUNCHER[harness], args, timeout, harness === 'claude' ? claudeAccessEnv(profile.env) : profile.env, { cwd: work });
    return stubMiss(id, stub.requests(), ran.code) ?? accessVerdict(id, harness, kind, ran, Date.now(), timeout);
  });
}

/** What K19's and K20's probes write: one JSON object per line, names, codes and key names only. */
export interface AccessProbeRecord {
  readonly event: string | null;
  /** K19: StopFailure's `error` (the documented field); K20: the error's name. */
  readonly code: string | null;
  readonly statusCode: number | null;
  /** The payload's (K19) or the error data's (K20) own key names, so the case can replay them. */
  readonly keys: readonly string[];
}

const PROBE_CODE = /^[A-Za-z0-9._:-]{1,64}$/;
const PROBE_KEY = /^[A-Za-z_]{1,40}$/;

/** The probe's records; a torn or foreign line is skipped. */
export async function readAccessProbeRecords(file: string): Promise<readonly AccessProbeRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: AccessProbeRecord[] = [];
  const code = (value: unknown): string | null => (typeof value === 'string' && PROBE_CODE.test(value) ? value : null);
  for (const line of text.split('\n').slice(0, 256)) {
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as { [key: string]: unknown };
      const keys = Array.isArray(value['keys']) ? value['keys'].filter((key): key is string => typeof key === 'string' && PROBE_KEY.test(key)).slice(0, 32) : [];
      const status = value['statusCode'];
      out.push({ event: code(value['event']), code: code(value['code']), statusCode: typeof status === 'number' && Number.isSafeInteger(status) ? status : null, keys });
    } catch {
      // A torn line is not a record.
    }
  }
  return out;
}

/**
 * K19's probe hook: it writes the event name, a code-checked `error` (StopFailure's documented
 * error type, code.claude.com/docs/en/hooks#stopfailure) and the payload's key names. It runs on StopFailure and, as a control that the probe itself ran, on UserPromptSubmit.
 * The error message and every other value are dropped in the hook.
 */
export function stopFailureProbe(markerFile: string): string {
  return [
    "'use strict';",
    'const fs = require("node:fs");',
    `const MARKER = ${JSON.stringify(markerFile)};`,
    `const CODE = ${PROBE_CODE.toString()};`,
    `const KEY = ${PROBE_KEY.toString()};`,
    'let text = "";',
    'process.stdin.on("data", (chunk) => { text += chunk; });',
    'process.stdin.on("end", () => {',
    '  let input;',
    '  try { input = JSON.parse(text); } catch (error) { return; }',
    '  if (!input || typeof input !== "object") return;',
    '  const code = (value) => (typeof value === "string" && CODE.test(value) ? value : null);',
    '  const keys = Object.keys(input).filter((key) => KEY.test(key)).slice(0, 32);',
    '  try { fs.appendFileSync(MARKER, JSON.stringify({ event: code(input.hook_event_name), code: code(input.error), keys }) + "\\n"); } catch (error) {}',
    '});',
    '',
  ].join('\n');
}

/**
 * The native payload K19 replays through the installed adapter: the fields the binary sent, each
 * holding the canary, except the common hook fields and the error code, which get plain values.
 * The permission mode, model and agent type get the canary too: the adapter keeps them only when
 * they have their id shape (B's LOW 30).
 */
export function stopFailureReplay(record: AccessProbeRecord, work: string): { readonly [key: string]: unknown } {
  const fixed: { readonly [key: string]: unknown } = { hook_event_name: 'StopFailure', session_id: 'ses_k19', transcript_path: join(work, 'k19.jsonl'), cwd: work, error: record.code };
  const rest = Object.fromEntries(record.keys.filter((key) => !(key in fixed) && key !== 'agent_id').map((key) => [key, `${ACCESS_CANARY} ${key}`]));
  return { ...rest, ...fixed };
}

/** K19: a real `-p` turn ends on K17's 402; the StopFailure probe must see `billing_error`, and the adapter must keep no text. */
async function claudeStopFailure(ctx: StubCaseContext): Promise<StubCaseResult> {
  const id = 'claude.session.stop-failure';
  return withStub(ctx, { script: errorScript('anthropic', 'credit') }, async (stub, work) => {
    const profile = profileFor(ctx, stub, STUB_CASE_MODELS.claude);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', 'no stub profile for Claude Code');
    const marker = join(work, 'k19-stop-failure.jsonl');
    const probe = join(work, 'k19-probe.cjs');
    await rm(marker, { force: true });
    await writeFile(probe, stopFailureProbe(marker));
    const handler = [{ hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}`, timeout: 10 }] }];
    const settings = JSON.stringify({ hooks: { UserPromptSubmit: handler, StopFailure: handler } });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', '1', '--model', STUB_CASE_MODELS.claude, '--settings', settings, PROMPT];
    const bound = accessBound(ctx);
    const ran = await ctx.cli.run(LAUNCHER.claude, args, bound, claudeAccessEnv(profile.env), { cwd: work });
    const timedOut = keptRetrying(id, ran, bound);
    if (timedOut !== null) return timedOut;
    const missed = stubMiss(id, stub.requests(), ran.code);
    if (missed !== null) return missed;
    return stopFailureVerdict(id, await readAccessProbeRecords(marker), ran, work, Date.now());
  });
}

/**
 * K19's verdict (exported for tests). EVENT_ABSENT only when the probe positively ran (its
 * UserPromptSubmit control) and the turn ended on the scripted billing error, yet no StopFailure
 * came: a probe that never ran or a turn that never failed is a failed case, never EVENT_ABSENT.
 */
export function stopFailureVerdict(id: string, records: readonly AccessProbeRecord[], ran: { readonly code: number; readonly stdout: string }, work: string, nowMs: number): StubCaseResult {
  const fired = records.find((item) => item.event === 'StopFailure');
  if (fired === undefined) {
    if (!records.some((item) => item.event === 'UserPromptSubmit')) return result(id, false, 'PROBE_NOT_RUN', `the probe hook never ran (not even on UserPromptSubmit; exit ${ran.code}), so StopFailure was not tested`);
    const signal = claudeTranscriptAccess(ran.stdout, nowMs);
    return signal?.errorType === 'billing_error'
      ? result(id, false, 'EVENT_ABSENT', 'the probe hook ran and the turn ended on the scripted billing error, but no StopFailure hook ran: this binary does not send the event')
      : result(id, false, 'TURN_NOT_FAILED', `the turn did not end on the scripted billing error (exit ${ran.code}), so StopFailure was not tested`);
  }
  if (fired.code !== 'billing_error') return result(id, false, 'WRONG_ERROR_TYPE', `StopFailure fired with error ${fired.code ?? 'absent'}, not billing_error`);
  const normalized = claudeAdapter.normalize(stopFailureReplay(fired, work));
  if (!normalized.ok || (normalized.event.kind !== 'turn.failed' && normalized.event.kind !== 'worker.failed')) return result(id, false, 'NOT_NORMALIZED', "the installed adapter did not read this binary's StopFailure payload as a failed turn");
  if (JSON.stringify(normalized.event).includes(ACCESS_CANARY)) return result(id, false, 'CANARY_KEPT', "the installed adapter kept a text field of this binary's StopFailure payload");
  return result(id, true, null, `StopFailure fired with error billing_error and fields ${fired.keys.join(', ')}; the installed adapter reads it as ${normalized.event.kind} and keeps no text`);
}

/**
 * K20's probe plugin: on `session.error`, and on an assistant `message.updated` whose `info.error`
 * is set, it writes the event, the error's name, its status code and the error data's key names.
 * It also writes `probe.loaded` when the harness loads it, the control that it ran at all.
 */
export function sessionErrorPlugin(markerFile: string): string {
  return [
    '// Jevris certify probe (throwaway profile only): notes a failed turn\'s error name and status code.',
    "import { appendFileSync } from 'node:fs';",
    `const MARKER = ${JSON.stringify(markerFile)};`,
    `const CODE = ${PROBE_CODE.toString()};`,
    `const KEY = ${PROBE_KEY.toString()};`,
    'const note = (event, error) => {',
    "  const e = error && typeof error === 'object' ? error : null;",
    "  const data = e && e.data && typeof e.data === 'object' ? e.data : null;",
    "  const code = e && typeof e.name === 'string' && CODE.test(e.name) ? e.name : null;",
    "  const statusCode = data && Number.isSafeInteger(data.statusCode) ? data.statusCode : null;",
    '  const keys = data ? Object.keys(data).filter((key) => KEY.test(key)).slice(0, 32) : [];',
    "  try { appendFileSync(MARKER, JSON.stringify({ event, code, statusCode, keys }) + '\\n'); } catch (error) {}",
    '};',
    'export const JevrisStubProbe = async () => {',
    "  try { appendFileSync(MARKER, JSON.stringify({ event: 'probe.loaded', code: null, statusCode: null, keys: [] }) + '\\n'); } catch (error) {}",
    '  return {',
    '    event: async ({ event }) => {',
    '      const props = event && event.properties;',
    '      if (!props) return;',
    "      if (event.type === 'session.error') note('session.error', props.error);",
    "      else if (event.type === 'message.updated' && props.info && props.info.role === 'assistant' && props.info.error) note('message.updated', props.info.error);",
    '    },',
    '  };',
    '};',
    '',
  ].join('\n');
}

/**
 * K20's verdict (exported for tests): the probe saw APIError 402, and the installed adapter reads
 * it as a failed turn with no text. EVENT_ABSENT only when the probe positively loaded and the run
 * ended on the scripted 402, yet no error event came.
 */
export function sessionErrorVerdict(id: string, harness: PluginHarness, records: readonly AccessProbeRecord[], ran: { readonly code: number; readonly stdout: string }, nowMs: number): StubCaseResult {
  const errors = records.filter((item) => item.event === 'session.error' || item.event === 'message.updated');
  const seen = errors.find((item) => item.code === 'APIError' && item.statusCode === 402);
  if (seen === undefined) {
    if (errors.length > 0) return result(id, false, 'WRONG_ERROR', `the failed turn reported ${errors.map((item) => `${item.event ?? 'an event'} ${item.code ?? 'no name'} ${item.statusCode ?? 'no status'}`).join('; ')}, not APIError 402`);
    if (!records.some((item) => item.event === 'probe.loaded')) return result(id, false, 'PROBE_NOT_LOADED', `the probe plugin never loaded (exit ${ran.code}), so the session events were not tested`);
    return opencodeTranscriptAccess(ran.stdout, harness, nowMs)?.status === 402
      ? result(id, false, 'EVENT_ABSENT', 'the probe plugin loaded and the run ended on the scripted 402, but no session.error or failed message reached the plugin bus')
      : result(id, false, 'TURN_NOT_FAILED', `the turn did not end on the scripted 402 (exit ${ran.code}), so the session events were not tested`);
  }
  const adapter = harness === 'kilocode' ? kilocodeAdapter : opencodeAdapter;
  const data = { ...Object.fromEntries(seen.keys.map((key) => [key, `${ACCESS_CANARY} ${key}`])), statusCode: 402 };
  const error = { name: 'APIError', data };
  const native =
    seen.event === 'session.error'
      ? { event: { type: 'session.error', properties: { sessionID: 'ses_k20', error } } }
      : { event: { type: 'message.updated', properties: { info: { id: 'msg_k20', sessionID: 'ses_k20', role: 'assistant', providerID: 'anthropic', modelID: STUB_CASE_MODELS[harness], error } } } };
  const normalized = adapter.normalize(native, { hookKey: 'event' });
  const failed = normalized.ok && (seen.event === 'session.error' ? normalized.event.kind === 'turn.failed' : normalized.event.kind === 'message.completed' && normalized.event.payload['errored'] === true);
  if (!normalized.ok || !failed) return result(id, false, 'NOT_NORMALIZED', `the installed adapter did not read ${seen.event ?? 'the event'} as a failed turn`);
  if (JSON.stringify(normalized.event).includes(ACCESS_CANARY)) return result(id, false, 'CANARY_KEPT', `the installed adapter kept a text field of ${seen.event ?? 'the event'}`);
  return result(id, true, null, `${seen.event ?? 'the event'} reached the plugin bus with APIError 402 and fields ${seen.keys.join(', ')}; the installed adapter reads it as a failed turn and keeps no text`);
}

/** K20: a real `run` turn ends on K17's 402 through the built-in anthropic provider. */
async function sessionError(ctx: StubCaseContext, harness: PluginHarness): Promise<StubCaseResult> {
  const id = `${harness}.session.error`;
  return withStub(ctx, { script: errorScript('anthropic', 'credit') }, async (stub, work) => {
    const profile = profileFor(ctx, stub, STUB_CASE_MODELS[harness]);
    if (profile === null) return result(id, false, 'NO_STUB_PROFILE', `no stub profile for ${harness}`);
    const marker = join(work, 'k20-session-error.jsonl');
    const file = join(work, 'jevris-stub-probe-k20.mjs');
    await rm(marker, { force: true });
    await writeFile(file, sessionErrorPlugin(marker));
    const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
    let config: { [key: string]: unknown };
    try {
      config = JSON.parse(profile.env[key] ?? '{}') as { [key: string]: unknown };
    } catch {
      return result(id, false, 'NO_STUB_PROFILE', 'the stub config did not parse');
    }
    const env = { ...profile.env, [key]: JSON.stringify({ ...config, plugin: [fileUrl(file)] }) };
    const bound = accessBound(ctx);
    const ran = await ctx.cli.run(LAUNCHER[harness], ['run', '--format', 'json', PROMPT], bound, env, { cwd: work });
    const timedOut = keptRetrying(id, ran, bound);
    if (timedOut !== null) return timedOut;
    const missed = stubMiss(id, stub.requests(), ran.code);
    if (missed !== null) return missed;
    return sessionErrorVerdict(id, harness, await readAccessProbeRecords(marker), ran, Date.now());
  });
}

function accessCases(ctx: StubCaseContext, harness: AccessCaseHarness): (() => Promise<StubCaseResult>)[] {
  return (['rate', 'credit', 'auth'] as const).map((kind) => () => accessLimitCase(ctx, harness, kind));
}

/** Runs this harness's stub cases. Never throws: a failure is a failed case. */
export async function runStubCases(ctx: StubCaseContext): Promise<readonly StubCaseResult[]> {
  const cases: (() => Promise<StubCaseResult>)[] =
    ctx.harness === 'claude'
      ? [() => claudeHookSpawn(ctx), () => claudeSubagentRoute(ctx), ...accessCases(ctx, 'claude'), () => claudeStopFailure(ctx)]
      : ctx.harness === 'opencode' || ctx.harness === 'kilocode'
        ? [
            () => systemTransform(ctx, ctx.harness as PluginHarness),
            () => sessionRoute(ctx, ctx.harness as PluginHarness),
            () => subagentRoute(ctx, ctx.harness as PluginHarness),
            () => pluginActualModel(ctx, ctx.harness as PluginHarness),
            () => modelsListHosts(ctx, ctx.harness as PluginHarness),
            () => hostRoute(ctx, ctx.harness as PluginHarness, false),
            () => hostRoute(ctx, ctx.harness as PluginHarness, true),
            ...accessCases(ctx, ctx.harness as PluginHarness),
            () => sessionError(ctx, ctx.harness as PluginHarness),
          ]
        : ctx.harness === 'codex'
          ? [() => codexStore(ctx), () => codexActualModel(ctx), () => codexSubagentRoute(ctx), ...accessCases(ctx, 'codex'), () => codexUsageReadCase({ env: ctx.env, profile: ctx.profile, ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }) })]
          : [];
  const out: StubCaseResult[] = [];
  for (const [index, run] of cases.entries()) {
    try {
      // The canary is code-shaped, so a verdict that prints a code could carry it: checked here, once, for every case (B's LOW 29).
      const found = await run();
      out.push(JSON.stringify(found).includes(ACCESS_CANARY) ? result(found.id, false, 'CANARY_KEPT', 'text from a scripted error reached the case result') : found);
    } catch {
      out.push(result(`${ctx.harness}.stub-case-${index + 1}`, false, 'STUB_CASE_ERROR', 'the case stopped with an error'));
    }
  }
  return out;
}

/** One line per case for certify's text output. */
export function stubCaseLines(cases: readonly StubCaseResult[]): string[] {
  return cases.map((item) => `stub case ${item.id}: ${item.passed ? 'pass' : `fail (${item.reasonCode ?? 'FAILED'})`}; ${item.detail}`);
}
