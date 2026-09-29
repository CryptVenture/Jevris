/**
 * Codex command-hook adapter (§15.1, CDX-02, CDX-03). Codex hook stdin is Claude-shaped but
 * it is its own protocol: `turn_id`, `model` and `permission_mode` are Codex extensions,
 * Stop and SubagentStop require JSON on a zero exit, PreToolUse rejects `continue`, and
 * PermissionRequest is never registered. A Claude-only field (PreModelSwitch, `from_model`,
 * `to_model`, `hookSpecificOutput`, a permission decision) is refused, never replayed.
 *
 * One actuator renders (owner decision OD-6, routing design R20): a subagent route on
 * PreToolUse(spawn_agent) is `permissionDecision: "allow"` with `updatedInput`, the tool input with
 * only `model` added. Codex 0.157.1 applies `updatedInput` only with `allow`, then dispatches the
 * call as usual, and the child inherits the parent's approval policy and sandbox
 * (codex-rs core/src/tools/registry.rs, core/src/agent/child_config.rs). So the allow approves
 * nothing else, from Codex 0.157.1's source:
 * - A hook's answer reaches dispatch only as `PreToolUseHookResult::{Continue { updated_input },
 *   Blocked }` (core/src/hook_runtime.rs): there is no approve result, so no hook can skip an
 *   approval or a sandbox check, on spawn_agent or on anything the child later runs. The
 *   spawn_agent handlers (core/src/tools/handlers/multi_agents/spawn.rs and multi_agents_v2/spawn.rs) request no
 *   approval under any policy; the child's own calls go through its inherited policy (K2 proves
 *   the escalated case asks).
 * - Several PreToolUse hooks: `should_block` is true when any hook blocks, and a blocked call
 *   takes no `updated_input` (hooks/src/events/pre_tool_use.rs, `run`), so a user's own deny wins
 *   over this allow. `ask` is unsupported there and fails open with or without Jevris.
 * The route is rendered only when the sidecar sends one, which needs `hooks.route` certified for
 * this version; certify certifies that only when its `codex.subagent-route` stub case passed on
 * the binary (K2). A spawn that already names a model or an effort is a pin and is never
 * rewritten.
 *
 * Under MultiAgentV2, Codex 0.157.1 offers spawn_agent inside a tool namespace ("collaboration" by
 * default) and names the call to PreToolUse `<namespace>spawn_agent` (core/src/tools/registry.rs,
 * function_hook_tool_name). Only the default namespace's exact name, `collaborationspawn_agent`,
 * is read as spawn_agent (owner decision DOMAINS 0a9dc8c); a namespace the user sets is not.
 */
import type { AdapterFixture, HarnessJson, HookOutcome, NormalizeContext, NormalizeResult, NormalizedHarnessEvent } from '@jevris/contracts';
import { commandHookParts, contextText, hookSpecificContext, isPlainObject, own, refuse, screen, stopBlockResponse, type CommandHookEvent, type StopRunning } from './common.js';

export const HARNESS_ID = 'codex' as const;
export const LAUNCHER_NAME = 'codex' as const;

export const CODEX_EVENTS: Readonly<Record<string, CommandHookEvent>> = {
  SessionStart: { kind: 'session.started', blocking: true, responseRequired: false },
  SessionEnd: { kind: 'session.ended', blocking: true, responseRequired: false },
  UserPromptSubmit: { kind: 'task.requested', blocking: true, responseRequired: false },
  PreToolUse: { kind: 'tool.proposed', blocking: true, responseRequired: false },
  PermissionRequest: { kind: 'permission.requested', blocking: true, responseRequired: false },
  PostToolUse: { kind: 'tool.finished', blocking: true, responseRequired: false },
  PreCompact: { kind: 'context.compacting', blocking: true, responseRequired: false },
  PostCompact: { kind: 'context.compacted', blocking: true, responseRequired: false },
  SubagentStart: { kind: 'worker.started', blocking: true, responseRequired: false },
  SubagentStop: { kind: 'worker.finished', blocking: true, responseRequired: true },
  Stop: { kind: 'turn.stopped', blocking: true, responseRequired: true },
  Interrupt: { kind: 'turn.interrupted', blocking: true, responseRequired: false },
};

/** Events Jevris registers. PermissionRequest is excluded: native approval stays authoritative. */
export const REGISTERED_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const;

/** Explicit timeouts (seconds). SessionEnd and Interrupt allow at most 3. */
export const EVENT_TIMEOUTS: Readonly<Record<(typeof REGISTERED_EVENTS)[number], number>> = {
  SessionStart: 5,
  SessionEnd: 2,
  UserPromptSubmit: 5,
  PreToolUse: 3,
  PostToolUse: 3,
  PreCompact: 10,
  PostCompact: 5,
  SubagentStart: 3,
  SubagentStop: 3,
  Stop: 5,
  Interrupt: 2,
};

const CLAUDE_ONLY = ['from_model', 'to_model', 'hookSpecificOutput', 'permissionDecision', 'custom_instructions'];

/** Events whose JSON output may carry `hookSpecificOutput.additionalContext`. */
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PostToolUse', 'PreToolUse']);

export function normalize(native: unknown, context: NormalizeContext = {}): NormalizeResult {
  const screened = screen(native);
  if (screened !== null) return refuse(screened, null);
  const input = native as Record<string, unknown>;
  const name = own(input, 'hook_event_name');
  if (typeof name !== 'string') return refuse('MISSING_FIELD', null);
  if (name === 'PreModelSwitch' || name === 'PostModelSwitch') return refuse('FOREIGN_PROTOCOL', name);
  if (CLAUDE_ONLY.some((key) => Object.hasOwn(input, key))) return refuse('FOREIGN_PROTOCOL', name);
  const spec = CODEX_EVENTS[name];
  if (spec === undefined) return refuse('UNKNOWN_EVENT', name);
  // The default-namespace spawn call reads as spawn_agent in the event (owner decision 0a9dc8c).
  const named = own(input, 'tool_name') === 'collaborationspawn_agent' ? { ...input, tool_name: 'spawn_agent' } : input;
  if (name === 'PostToolUse') {
    const error = mcpToolError(own(named, 'tool_response'));
    if (error !== null) return commandHookParts(HARNESS_ID, name, FAILED_TOOL, { ...named, error }, context);
  }
  return commandHookParts(HARNESS_ID, name, spec, named, context);
}

/** A PostToolUse whose tool reported an error: a failed call, as Claude Code's PostToolUseFailure. */
const FAILED_TOOL: CommandHookEvent = { kind: 'tool.failed', blocking: true, responseRequired: false };

/**
 * G7 (harness parity audit): which failures a Codex PostToolUse shows. Read from the Codex
 * source at tag rust-v0.157.1 (codex-rs/core/src/tools/context.rs and protocol/src/mcp.rs):
 * - An MCP tool's `tool_response` is its CallToolResult, `{ content, structuredContent?,
 *   isError?, _meta? }`. `isError: true` is a failed call; the first text item is its error.
 * - Bash's `tool_response` is only the output text, with no exit status, and apply_patch's is
 *   its message. Neither says whether it failed, so both stay `tool.finished`: Jevris never
 *   guesses a failure from output text (a vendor limit, recorded in the harness docs).
 * Returns the error text ('' when the result carries none), or null for anything else.
 */
export function mcpToolError(response: unknown): string | null {
  if (!isPlainObject(response) || own(response, 'isError') !== true || !Array.isArray(own(response, 'content'))) return null;
  for (const item of own(response, 'content') as readonly unknown[]) {
    if (isPlainObject(item) && own(item, 'type') === 'text' && typeof own(item, 'text') === 'string') return own(item, 'text') as string;
  }
  return '';
}

/** The Codex tool whose model a route may set (OD-6). */
export const ROUTABLE_TOOLS = ['spawn_agent'] as const;

/** The PreToolUse names Codex 0.157.1 gives spawn_agent: plain, and in the default MultiAgentV2 namespace. */
export const SPAWN_HOOK_NAMES = ['spawn_agent', 'collaborationspawn_agent'] as const;

/** Whether a hook's `tool_name` is spawn_agent by one of SPAWN_HOOK_NAMES, exactly. */
export function isSpawnHookName(name: unknown): boolean {
  return (SPAWN_HOOK_NAMES as readonly unknown[]).includes(name);
}

/** A Codex model id as spawn_agent takes it (codex-rs models.json slugs). */
const CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Tool-input keys that pin the child's model choice: a spawn that names either is never routed. */
const PIN_KEYS = ['model', 'reasoning_effort'] as const;

/**
 * The routed spawn_agent input: the native tool input, key for key, with only `model` added; null
 * for a pin (the call already names `model` or `reasoning_effort`) or a bad id. A route's
 * `variant` (a learned effort) is never applied here: the rewrite adds the model and nothing else.
 */
export function routeInput(native: unknown, model: string): { readonly [key: string]: HarnessJson } | null {
  if (!isPlainObject(native) || !CODEX_MODEL_ID.test(model)) return null;
  const toolInput = own(native, 'tool_input');
  if (!isPlainObject(toolInput) || PIN_KEYS.some((key) => Object.hasOwn(toolInput, key))) return null;
  return { ...(toolInput as { [key: string]: HarnessJson }), model };
}

/** The last guard: PreToolUse(spawn_agent) of this very input, every key kept, only `model` added. */
function routeAllowed(event: NormalizedHarnessEvent, native: unknown, updatedInput: { readonly [key: string]: HarnessJson }): boolean {
  if (event.nativeEventName !== 'PreToolUse') return false;
  if (!(ROUTABLE_TOOLS as readonly (string | null)[]).includes(event.toolName)) return false;
  if (!isPlainObject(native) || !isSpawnHookName(own(native, 'tool_name'))) return false;
  const toolInput = own(native, 'tool_input');
  if (!isPlainObject(toolInput)) return false;
  const before = Object.keys(toolInput);
  const after = Object.keys(updatedInput);
  if (after.length !== before.length + 1 || !after.every((key) => before.includes(key) || key === 'model')) return false;
  return before.every((key) => key !== 'model' && Object.hasOwn(updatedInput, key) && JSON.stringify(updatedInput[key]) === JSON.stringify(toolInput[key]));
}

/**
 * The exact stdout for a zero exit. Observe is empty, except where Codex requires JSON
 * (Stop, SubagentStop), which get `{}`: no `decision`, so the stop proceeds.
 * No `continue` is ever rendered, and a permission decision and `updatedInput` only as a routed
 * spawn_agent (OD-6, below).
 */
export function protocolResponse(event: NormalizedHarnessEvent | null, outcome: HookOutcome, native?: unknown): string {
  if (event === null) return '';
  const name = event.nativeEventName;
  if (outcome.kind === 'route') {
    const updatedInput = native === undefined ? null : routeInput(native, outcome.model);
    if (updatedInput === null || !routeAllowed(event, native, updatedInput)) return event.responseRequired ? '{}' : '';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } });
  }
  const required = event.responseRequired ? '{}' : '';
  const text = contextText(outcome);
  if (text === null) return required;
  if (outcome.kind === 'context' && CONTEXT_EVENTS.has(name)) return hookSpecificContext(name, text);
  if (outcome.kind === 'explain' && name !== 'SessionEnd') return JSON.stringify({ systemMessage: text });
  return required;
}

const base = { session_id: 'thr_1', transcript_path: null, cwd: '/work', model: 'gpt-5.5' };

export const FIXTURES: readonly AdapterFixture[] = [
  { id: 'codex.session-start', native: { ...base, hook_event_name: 'SessionStart', source: 'startup', permission_mode: 'default' }, kind: 'session.started' },
  { id: 'codex.session-end', native: { ...base, hook_event_name: 'SessionEnd', reason: 'other' }, kind: 'session.ended' },
  { id: 'codex.prompt', native: { ...base, hook_event_name: 'UserPromptSubmit', turn_id: 't1', permission_mode: 'default', prompt: 'fix the test' }, kind: 'task.requested' },
  {
    id: 'codex.pre-tool',
    native: { ...base, hook_event_name: 'PreToolUse', turn_id: 't1', permission_mode: 'default', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' } },
    kind: 'tool.proposed',
  },
  {
    id: 'codex.post-tool',
    native: { ...base, hook_event_name: 'PostToolUse', turn_id: 't1', permission_mode: 'default', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' }, tool_response: 'ok' },
    kind: 'tool.finished',
  },
  {
    id: 'codex.pre-spawn-agent',
    native: { ...base, hook_event_name: 'PreToolUse', turn_id: 't1', permission_mode: 'default', tool_name: 'spawn_agent', tool_use_id: 'call_2', tool_input: { message: 'find x', task_name: 'search', agent_type: 'explorer' } },
    kind: 'tool.proposed',
  },
  {
    id: 'codex.pre-spawn-agent-namespaced',
    native: { ...base, hook_event_name: 'PreToolUse', turn_id: 't1', permission_mode: 'default', tool_name: 'collaborationspawn_agent', tool_use_id: 'call_4', tool_input: { message: 'find x', task_name: 'search' } },
    kind: 'tool.proposed',
  },
  {
    id: 'codex.pre-spawn-agent-pinned',
    native: { ...base, hook_event_name: 'PreToolUse', turn_id: 't1', permission_mode: 'default', tool_name: 'spawn_agent', tool_use_id: 'call_3', tool_input: { message: 'find x', task_name: 'search', model: 'gpt-6-luna' } },
    kind: 'tool.proposed',
  },
  { id: 'codex.pre-compact', native: { ...base, hook_event_name: 'PreCompact', turn_id: 't2', trigger: 'auto' }, kind: 'context.compacting' },
  { id: 'codex.post-compact', native: { ...base, hook_event_name: 'PostCompact', turn_id: 't2', trigger: 'auto' }, kind: 'context.compacted' },
  { id: 'codex.subagent-start', native: { ...base, hook_event_name: 'SubagentStart', turn_id: 't3', agent_id: 'a1', agent_type: 'worker', permission_mode: 'default' }, kind: 'worker.started' },
  { id: 'codex.subagent-stop', native: { ...base, hook_event_name: 'SubagentStop', turn_id: 't3', agent_id: 'a1', agent_type: 'worker', stop_hook_active: false, last_assistant_message: 'done' }, kind: 'worker.finished' },
  { id: 'codex.stop', native: { ...base, hook_event_name: 'Stop', turn_id: 't4', permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'done' }, kind: 'turn.stopped' },
  { id: 'codex.interrupt', native: { ...base, hook_event_name: 'Interrupt', turn_id: 't5', permission_mode: 'default' }, kind: 'turn.interrupted' },
  { id: 'codex.claude-switch', native: { ...base, hook_event_name: 'PreModelSwitch', from_model: 'a', to_model: 'b' }, kind: null, refusal: 'FOREIGN_PROTOCOL' },
  { id: 'codex.unknown', native: { ...base, hook_event_name: 'Notification' }, kind: null, refusal: 'UNKNOWN_EVENT' },
  { id: 'codex.array', native: [], kind: null, refusal: 'NOT_OBJECT' },
];

/**
 * VER-05: the one continuation of a stop on an unchanged missing-evidence condition, in the
 * documented Stop block form. The launcher calls it only for a certified reminder; `running` names
 * the missing checks a background run is still producing.
 */
export function stopContinuationResponse(event: NormalizedHarnessEvent | null, missingEvidence: readonly unknown[], running?: StopRunning): string {
  return stopBlockResponse(event, missingEvidence, running);
}
