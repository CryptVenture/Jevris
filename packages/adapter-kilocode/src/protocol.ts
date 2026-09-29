/**
 * Kilo plugin adapter (§15.1). Kilo plugins run in-process and receive hook calls
 * (`tool.execute.before` and `after`, `chat.message`, `command.execute.before`,
 * `experimental.session.compacting`)
 * plus bus events through `event` (`event.type`). The shim passes
 * `{ hookKey, input, output }`; this adapter reads it into a normalized event and renders
 * the mutations the shim may apply: context lines on a compaction hook, text shown on a turn,
 * and a certified route's model (a task call's subagent, R20; a top-level turn, OD-8). The shim
 * writes a model and nothing else. `permission.ask` is never registered.
 */
import type { AdapterFixture, HookOutcome, NormalizeContext, NormalizeResult, NormalizedHarnessEvent } from '@jevris/contracts';
import { createPluginHooks, own, pluginEvent, pluginResponse, refuse, screen, type PluginForward, type PluginHooks, type ProjectConfigCheck } from './common.js';

export const HARNESS_ID = 'kilocode' as const;
export const LAUNCHER_NAME = 'kilo' as const;
/** Hook keys the shim registers. Bus event types arrive through `event`. */
export const HOOK_KEYS = ['event', 'tool.execute.before', 'tool.execute.after', 'chat.message', 'command.execute.before', 'experimental.session.compacting', 'experimental.chat.system.transform'] as const;

export function normalize(native: unknown, context: NormalizeContext = {}): NormalizeResult {
  const screened = screen(native);
  if (screened !== null) return refuse(screened, null);
  const input = native as Record<string, unknown>;
  if (typeof own(input, 'hook_event_name') === 'string') return refuse('FOREIGN_PROTOCOL', String(own(input, 'hook_event_name')).slice(0, 64));
  return pluginEvent(HARNESS_ID, input, context.hookKey);
}

export function protocolResponse(event: NormalizedHarnessEvent | null, outcome: HookOutcome, native?: unknown): string {
  return pluginResponse(event, outcome, native);
}

/** The hooks object a shim returns from its plugin function. */
export function createHooks(forward: PluginForward, responseTimeoutMs?: number, projectConfig?: ProjectConfigCheck): PluginHooks {
  return createPluginHooks({ harness: HARNESS_ID, forward, ...(responseTimeoutMs === undefined ? {} : { responseTimeoutMs }), ...(projectConfig === undefined ? {} : { projectConfig }) });
}

export const FIXTURES: readonly AdapterFixture[] = [
  { id: 'kilocode.session-created', native: { hookKey: 'event', event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } }, kind: 'session.started' },
  { id: 'kilocode.session-idle', native: { event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } }, kind: 'turn.stopped' },
  { id: 'kilocode.session-compacted', native: { event: { type: 'session.compacted', properties: { sessionID: 'ses_1' } } }, kind: 'context.compacted' },
  { id: 'kilocode.permission-asked', native: { event: { type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'per_1' } } }, kind: 'permission.asked' },
  {
    id: 'kilocode.tool-before',
    hookKey: 'tool.execute.before',
    native: { hookKey: 'tool.execute.before', input: { tool: 'bash', sessionID: 'ses_1', callID: 'call_1' }, output: { args: { command: 'npm test' } } },
    kind: 'tool.proposed',
  },
  {
    id: 'kilocode.task-before',
    hookKey: 'tool.execute.before',
    native: { hookKey: 'tool.execute.before', input: { tool: 'task', sessionID: 'ses_1', callID: 'call_2' }, output: { args: { description: 'find x', prompt: 'find x', subagent_type: 'explore' } } },
    kind: 'tool.proposed',
  },
  {
    id: 'kilocode.task-before-pinned',
    hookKey: 'tool.execute.before',
    native: { hookKey: 'tool.execute.before', input: { tool: 'task', sessionID: 'ses_1', callID: 'call_3' }, output: { args: { description: 'find x', prompt: 'find x', subagent_type: 'explore', model: 'claude-sonnet-4-5' } } },
    kind: 'tool.proposed',
  },
  {
    id: 'kilocode.tool-after',
    hookKey: 'tool.execute.after',
    native: { hookKey: 'tool.execute.after', input: { tool: 'bash', sessionID: 'ses_1', callID: 'call_1' }, output: { title: 'npm test', output: 'ok', metadata: {} } },
    kind: 'tool.finished',
  },
  {
    id: 'kilocode.chat-message',
    hookKey: 'chat.message',
    native: { hookKey: 'chat.message', input: { sessionID: 'ses_1', agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, messageID: 'msg_1' }, output: { message: {}, parts: [] } },
    kind: 'task.requested',
  },
  {
    id: 'kilocode.compacting',
    hookKey: 'experimental.session.compacting',
    native: { hookKey: 'experimental.session.compacting', input: { sessionID: 'ses_1' }, output: { context: [], prompt: undefined } },
    kind: 'context.compacting',
  },
  {
    id: 'kilocode.command',
    hookKey: 'command.execute.before',
    native: { hookKey: 'command.execute.before', input: { command: 'review', sessionID: 'ses_1', arguments: 'src/' }, output: { parts: [] } },
    kind: 'command.requested',
  },
  {
    id: 'kilocode.message-completed',
    native: { event: { type: 'message.updated', properties: { info: { id: 'msg_2', sessionID: 'ses_1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', time: { created: 1, completed: 2 }, tokens: { input: 10, output: 5, reasoning: 0 } } } } },
    kind: 'message.completed',
  },
  { id: 'kilocode.message-streaming', native: { event: { type: 'message.updated', properties: { info: { id: 'msg_2', sessionID: 'ses_1', role: 'assistant', time: { created: 1 } } } } }, kind: null, refusal: 'UNKNOWN_EVENT' },
  { id: 'kilocode.noise', native: { event: { type: 'message.part.updated', properties: {} } }, kind: null, refusal: 'UNKNOWN_EVENT' },
  { id: 'kilocode.permission-hook', native: { hookKey: 'permission.ask', input: { id: 'per_1' }, output: { status: 'ask' } }, kind: null, refusal: 'UNKNOWN_EVENT' },
  { id: 'kilocode.claude-shaped', native: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, kind: null, refusal: 'FOREIGN_PROTOCOL' },
];
