/**
 * Claude Code command-hook adapter (§3.2, §3.3, CLA-02, CLA-04, CLA-05).
 *
 * Rendering rules:
 * - observe is empty stdout for every event (Claude treats exit 0 + nothing as success);
 * - context uses `hookSpecificOutput.additionalContext` only on events that accept it;
 * - route rewrites an Agent or Task tool's input only when the user did not pin a model, keeps
 *   every input key, changes nothing but `model`, and never sets `permissionDecision`. A route
 *   that carries a short `context` note also sets `additionalContext` in the same
 *   `hookSpecificOutput` (rewrite plus instruct, owner decision 2026-10-08); The
 *   sidecar sends only a registry model id (E 7a6f7a5); the launcher hands this adapter the
 *   native input, and the adapter maps the id to the alias Claude Code's Agent tool takes;
 * - explain is a `systemMessage`. PreModelSwitch is explained, never answered with "ask" or
 *   a block, so the user's requested switch stays theirs.
 */
import type { AdapterFixture, HarnessJson, HookOutcome, NormalizeContext, NormalizeResult, NormalizedHarnessEvent } from '@jevris/contracts';
import { commandHookParts, contextText, hookSpecificContext, isPlainObject, own, refuse, screen, stopBlockResponse, type CommandHookEvent, type StopRunning } from './common.js';

export const HARNESS_ID = 'claude' as const;
export const LAUNCHER_NAME = 'claude' as const;

export const CLAUDE_EVENTS: Readonly<Record<string, CommandHookEvent>> = {
  SessionStart: { kind: 'session.started', blocking: true, responseRequired: false },
  SessionEnd: { kind: 'session.ended', blocking: true, responseRequired: false },
  UserPromptSubmit: { kind: 'task.requested', blocking: true, responseRequired: false },
  PreToolUse: { kind: 'tool.proposed', blocking: true, responseRequired: false },
  PostToolUse: { kind: 'tool.finished', blocking: true, responseRequired: false },
  PostToolUseFailure: { kind: 'tool.failed', blocking: true, responseRequired: false },
  PreCompact: { kind: 'context.compacting', blocking: true, responseRequired: false },
  PostCompact: { kind: 'context.compacted', blocking: true, responseRequired: false },
  PreModelSwitch: { kind: 'model.change.requested', blocking: true, responseRequired: false },
  PostModelSwitch: { kind: 'model.changed', blocking: true, responseRequired: false },
  SubagentStart: { kind: 'worker.started', blocking: true, responseRequired: false },
  SubagentStop: { kind: 'worker.finished', blocking: true, responseRequired: false },
  Stop: { kind: 'turn.stopped', blocking: true, responseRequired: false },
};

/**
 * Events the adapter reads but the plugin does not register until certify proves the installed
 * binary honours them (B's MEDIUM 26: a binary that predates an event might refuse the whole
 * plugin, and every hook with it). StopFailure (access limits R68) fires when a turn ends on an
 * API error; Claude Code ignores its output on every exit code, so it only observes, and the
 * launcher reads its error code for an access signal.
 */
export const CLAUDE_GATED_EVENTS: Readonly<Record<string, CommandHookEvent>> = {
  StopFailure: { kind: 'turn.failed', blocking: false, responseRequired: false },
};

/** The worker-routing actuator only ever touches these tools. */
export const ROUTABLE_TOOLS = ['Agent', 'Task'] as const;

const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'PreToolUse']);

export function normalize(native: unknown, context: NormalizeContext = {}): NormalizeResult {
  const screened = screen(native);
  if (screened !== null) return refuse(screened, null);
  const input = native as Record<string, unknown>;
  const name = own(input, 'hook_event_name');
  if (typeof name !== 'string') return refuse('MISSING_FIELD', null);
  if (name === 'Interrupt' || Object.hasOwn(input, 'turn_id')) return refuse('FOREIGN_PROTOCOL', name.slice(0, 64));
  const spec = CLAUDE_EVENTS[name] ?? CLAUDE_GATED_EVENTS[name];
  if (spec === undefined) return refuse('UNKNOWN_EVENT', name.slice(0, 64));
  return commandHookParts(HARNESS_ID, name, spec, input, context);
}

function stringList(value: HarnessJson | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A route may only add or change `model`, and must keep every key the tool input had. */
function routeAllowed(event: NormalizedHarnessEvent, updatedInput: { readonly [key: string]: HarnessJson }): boolean {
  if (event.nativeEventName !== 'PreToolUse') return false;
  if (!(ROUTABLE_TOOLS as readonly (string | null)[]).includes(event.toolName)) return false;
  if (event.payload.requestedModel !== undefined) return false;
  if (!isPlainObject(updatedInput)) return false;
  const model = updatedInput.model;
  if (typeof model !== 'string' || model.length === 0 || model.length > 128) return false;
  const before = stringList(event.payload.toolInputKeys);
  if (before.length === 0) return false;
  const after = Object.keys(updatedInput);
  if (!before.every((key) => after.includes(key))) return false;
  return after.every((key) => before.includes(key) || key === 'model');
}

/**
 * The Agent tool's `model` values Jevris may pass: Claude Code's family aliases, as its Agent SDK
 * types them (`model?: "sonnet" | "opus" | "haiku" | "fable"`; routing design R25). Only these
 * are proven by the hooks.route certification (the conformance route); any other family has no
 * alias here and is never routed. Which exact model an alias resolves to is Claude Code's choice
 * (K1); the decision engine abstains where that would be the wrong model.
 */
export const SUBAGENT_MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type SubagentModelAlias = (typeof SUBAGENT_MODEL_ALIASES)[number];

/** The alias for a registry model id by its family (`claude-haiku-4-5` is haiku), or null. */
export function subagentAlias(model: string): SubagentModelAlias | null {
  const id = model.trim().toLowerCase();
  if ((SUBAGENT_MODEL_ALIASES as readonly string[]).includes(id)) return id as SubagentModelAlias;
  const family = /^claude-(?:\d+(?:[.-]\d+)*-)?(haiku|sonnet|opus|fable)(?:-|$)/.exec(id)?.[1];
  return family === undefined ? null : (family as SubagentModelAlias);
}

/** Builds the routed tool input: the original input with `model` set. Nothing else changes. */
export function routedInput(native: unknown, model: string): { readonly [key: string]: HarnessJson } | null {
  if (!isPlainObject(native)) return null;
  const toolInput = own(native, 'tool_input');
  if (!isPlainObject(toolInput) || Object.hasOwn(toolInput, 'model')) return null;
  return { ...(toolInput as { [key: string]: HarnessJson }), model };
}

/**
 * The routed tool input for a wire route: the registry id as its alias, set on the native tool
 * input. Null when the model has no alias or the input already names a model.
 */
export function routeInput(native: unknown, model: string): { readonly [key: string]: HarnessJson } | null {
  const alias = subagentAlias(model);
  return alias === null ? null : routedInput(native, alias);
}

/**
 * `native` is the hook input exactly as the harness sent it; the launcher omits it when it had to
 * cut the input to fit, so a route never rewrites a cut prompt. routeAllowed is the last guard.
 */
export function protocolResponse(event: NormalizedHarnessEvent | null, outcome: HookOutcome, native?: unknown): string {
  if (event === null) return '';
  const name = event.nativeEventName;
  if (outcome.kind === 'route') {
    const updatedInput = native === undefined ? null : routeInput(native, outcome.model);
    if (updatedInput === null || !routeAllowed(event, updatedInput)) return '';
    // Rewrite plus instruct (owner decision 2026-10-08): the short note for the model rides beside
    // the rewrite in the same hookSpecificOutput. It is never prompt or description text.
    const note = typeof outcome.context === 'string' ? contextText({ kind: 'context', text: outcome.context }) : null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput, ...(note === null ? {} : { additionalContext: note }) } });
  }
  const text = contextText(outcome);
  if (text === null) return '';
  if (outcome.kind === 'context' && CONTEXT_EVENTS.has(name)) return hookSpecificContext(name, text);
  if (outcome.kind === 'explain' && name !== 'SessionEnd') return JSON.stringify({ systemMessage: text });
  return '';
}

const base = { session_id: 'ses_1', transcript_path: '/home/u/.claude/projects/p/ses_1.jsonl', cwd: '/work', permission_mode: 'default' };

export const FIXTURES: readonly AdapterFixture[] = [
  { id: 'claude.session-start', native: { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-5' }, kind: 'session.started' },
  { id: 'claude.session-start-compact', native: { ...base, hook_event_name: 'SessionStart', source: 'compact', model: 'claude-sonnet-4-5' }, kind: 'session.started' },
  { id: 'claude.session-end', native: { ...base, hook_event_name: 'SessionEnd', reason: 'other' }, kind: 'session.ended' },
  { id: 'claude.prompt', native: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix the test', prompt_id: 'p1' }, kind: 'task.requested' },
  {
    id: 'claude.pre-agent',
    native: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { description: 'search', prompt: 'find x', subagent_type: 'Explore' } },
    kind: 'tool.proposed',
  },
  {
    id: 'claude.pre-agent-pinned',
    native: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_2', tool_input: { description: 'search', prompt: 'find x', model: 'opus' } },
    kind: 'tool.proposed',
  },
  { id: 'claude.post-tool', native: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } }, kind: 'tool.finished' },
  { id: 'claude.post-tool-failure', native: { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_4', tool_input: { command: 'npm test' }, error: 'exit 1' }, kind: 'tool.failed' },
  { id: 'claude.pre-compact', native: { ...base, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' }, kind: 'context.compacting' },
  { id: 'claude.post-compact', native: { ...base, hook_event_name: 'PostCompact', trigger: 'auto' }, kind: 'context.compacted' },
  { id: 'claude.pre-switch', native: { ...base, hook_event_name: 'PreModelSwitch', from_model: 'claude-sonnet-4-5', to_model: 'claude-opus-4-5' }, kind: 'model.change.requested' },
  { id: 'claude.post-switch', native: { ...base, hook_event_name: 'PostModelSwitch', from_model: 'claude-sonnet-4-5', to_model: 'claude-opus-4-5' }, kind: 'model.changed' },
  { id: 'claude.subagent-start', native: { ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, kind: 'worker.started' },
  { id: 'claude.subagent-stop', native: { ...base, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', stop_hook_active: false }, kind: 'worker.finished' },
  { id: 'claude.stop', native: { ...base, hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'done' }, kind: 'turn.stopped' },
  { id: 'claude.codex-shaped', native: { ...base, hook_event_name: 'Stop', turn_id: 't1' }, kind: null, refusal: 'FOREIGN_PROTOCOL' },
  { id: 'claude.unknown', native: { ...base, hook_event_name: 'Nonexistent' }, kind: null, refusal: 'UNKNOWN_EVENT' },
  { id: 'claude.polluted', native: JSON.parse('{"hook_event_name":"Stop","__proto__":{"x":1}}'), kind: null, refusal: 'UNSAFE_KEY' },
];

/**
 * VER-05: the one continuation of a stop on an unchanged missing-evidence condition, in the
 * documented Stop block form. The launcher calls it only for a certified reminder; `running` names
 * the missing checks a background run is still producing.
 */
export function stopContinuationResponse(event: NormalizedHarnessEvent | null, missingEvidence: readonly unknown[], running?: StopRunning): string {
  return stopBlockResponse(event, missingEvidence, running);
}
