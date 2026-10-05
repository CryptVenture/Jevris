/**
 * Antigravity hook adapter (§15.1, AGY-03). Antigravity hooks are named groups with a
 * camelCase JSON contract and no event name on stdin, so the registered command passes
 * `--event <Name>` and the launcher hands it over as `context.hookKey`.
 *
 * Safety (documented SSOT deviation, owner-approved): Antigravity's PreToolUse `decision`
 * "allow" auto-approves the tool call, which would override native permissions. Jevris never
 * registers PreToolUse, and if one reaches it anyway it prints nothing (no decision).
 * Observation uses PostToolUse, PreInvocation, PostInvocation and Stop.
 */
import type { AdapterFixture, HookOutcome, NormalizeContext, NormalizeResult, NormalizedHarnessEvent } from '@jevris/contracts';
import { WRITE_TOOL_NAMES, boundedPayload, buildEvent, contextText, count, failureEvidence, failureFeatures, field, flag, intentOf, isPlainObject, keyNames, own, refuse, scopeIntent, screen, sizeOf, stopReason, untrustedIntent, type StopRunning } from './common.js';

export const HARNESS_ID = 'antigravity' as const;
export const LAUNCHER_NAME = 'agy' as const;

const EVENTS: Readonly<Record<string, { readonly kind: string }>> = {
  PreToolUse: { kind: 'tool.proposed' },
  PostToolUse: { kind: 'tool.finished' },
  PreInvocation: { kind: 'invocation.started' },
  PostInvocation: { kind: 'invocation.finished' },
  Stop: { kind: 'turn.stopped' },
};

/** Registered events. PreToolUse is deliberately absent. */
export const REGISTERED_EVENTS = ['PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'] as const;
/** Timeouts in seconds; Antigravity's default is 30. */
export const EVENT_TIMEOUTS: Readonly<Record<(typeof REGISTERED_EVENTS)[number], number>> = {
  PostToolUse: 5,
  PreInvocation: 5,
  PostInvocation: 5,
  Stop: 5,
};

/**
 * The error text of a PostToolUse, or null when the call did not fail. A call failed when its
 * `error` is text with something in it. The text is free text, so unlike an id or a path it is not
 * held to one short control-character-free line: a real tool error has several lines, colour codes
 * and any length (the hook's input cap already bounds it). The text never travels: the failure
 * record keeps only closed codes and a one-way digest of its normalized form (`failureFeatures`,
 * which also reads no more than its own cap, and `failureEvidence`), the same as for every other harness.
 */
function errorTextOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function inferName(input: Record<string, unknown>): string | null {
  const named = own(input, 'event');
  if (typeof named === 'string' && Object.hasOwn(EVENTS, named)) return named;
  if (isPlainObject(own(input, 'toolCall'))) return Object.hasOwn(input, 'error') ? 'PostToolUse' : 'PreToolUse';
  if (typeof own(input, 'terminationReason') === 'string' || typeof own(input, 'fullyIdle') === 'boolean') return 'Stop';
  if (typeof own(input, 'invocationNum') === 'number') return 'PreInvocation';
  return null;
}

export function normalize(native: unknown, context: NormalizeContext = {}): NormalizeResult {
  const screened = screen(native);
  if (screened !== null) return refuse(screened, null);
  const input = native as Record<string, unknown>;
  if (typeof own(input, 'hook_event_name') === 'string') return refuse('FOREIGN_PROTOCOL', String(own(input, 'hook_event_name')).slice(0, 64));
  if (Object.hasOwn(input, 'decision') || Object.hasOwn(input, 'permissionOverrides')) return refuse('FOREIGN_PROTOCOL', null);
  const name = context.hookKey ?? inferName(input);
  if (name === null) return refuse('MISSING_FIELD', null);
  const spec = EVENTS[name];
  if (spec === undefined) return refuse('UNKNOWN_EVENT', name.slice(0, 64));
  const toolCall = own(input, 'toolCall');
  const tool = isPlainObject(toolCall) ? toolCall : null;
  const error = errorTextOf(own(input, 'error'));
  const workspaces = own(input, 'workspacePaths');
  const firstWorkspace = Array.isArray(workspaces) ? field(workspaces[0], 4096) : null;
  const kind = name === 'PostToolUse' && error !== null ? 'tool.failed' : spec.kind;
  const toolName = tool === null ? null : field(own(tool, 'name'), 128);
  const args = tool !== null && isPlainObject(own(tool, 'args')) ? (own(tool, 'args') as Record<string, unknown>) : {};
  // Antigravity hooks carry no user prompt, so there is never a task intent (parity matrix).
  const intent = intentOf({
    scope: kind === 'tool.finished' && toolName !== null && WRITE_TOOL_NAMES.has(toolName) ? scopeIntent([own(args, 'TargetFile'), own(args, 'targetFile')], firstWorkspace) : null,
    evidence: kind === 'tool.failed' ? failureEvidence(toolName, own(input, 'error')) : null,
    failure: kind === 'tool.failed' ? failureFeatures({ toolName, toolInput: args, error: own(input, 'error') }) : null,
    // GOV-12: Antigravity's PostToolUse carries no tool output, only the error of a failed call.
    untrusted: kind === 'tool.failed' ? untrustedIntent(toolName, count(own(input, 'stepIdx')) === null ? null : `step-${count(own(input, 'stepIdx'))}`, own(input, 'error')) : null,
    // GOV-13: no effect. PreToolUse is never registered (D-F1); one that arrives anyway is only observed.
  });
  return buildEvent({
    harness: HARNESS_ID,
    nativeEventName: name,
    kind,
    intent,
    sessionId: field(own(input, 'conversationId')),
    toolName,
    model: field(own(input, 'modelName'), 128),
    cwd: firstWorkspace,
    trigger: field(own(input, 'terminationReason'), 64),
    blocking: true,
    responseRequired: name !== 'PreToolUse',
    payload: boundedPayload({
      toolArgKeys: tool === null ? null : keyNames(own(tool, 'args')),
      toolArgBytes: tool === null ? null : sizeOf(own(tool, 'args')),
      stepIdx: count(own(input, 'stepIdx')),
      invocationNum: count(own(input, 'invocationNum')),
      initialNumSteps: count(own(input, 'initialNumSteps')),
      executionNum: count(own(input, 'executionNum')),
      fullyIdle: flag(own(input, 'fullyIdle')),
      // G6: Antigravity has no stop_hook_active. A Stop on the first execution attempt
      // (executionNum 1) is a first stop; a later attempt follows a continue. Unknown: null.
      stopHookActive: name === 'Stop' ? stopAfterContinue(count(own(input, 'executionNum'))) : null,
      failed: name === 'PostToolUse' ? error !== null : null,
      // A Stop that ended on an error (terminationReason "error") is a failed turn, signal or not;
      // only the fixed flag is kept, never the error text (D's session access subscriber).
      errored: name === 'Stop' && own(input, 'terminationReason') === 'error' ? true : null,
      workspaceCount: Array.isArray(workspaces) ? workspaces.length : null,
    }),
    dedup: [count(own(input, 'stepIdx')), count(own(input, 'invocationNum')), count(own(input, 'executionNum'))],
  });
}

function stopAfterContinue(executionNum: number | null): boolean | null {
  if (executionNum === null || executionNum < 1) return null;
  return executionNum > 1;
}

/**
 * G6 (owner decision, DOMAINS 9d6a66d): the verification gate's one continuation, through the
 * Stop output Antigravity documents, `{ "decision": "continue", "reason" }`: the reason is
 * injected as a system message and the agent re-enters its loop (antigravity.google/docs/hooks,
 * read 27 September 2026). Only on a first stop (stopHookActive false), when the agent stopped by
 * itself (terminationReason model_stop) and is fully idle; never after an error or the step
 * limit, never while background work runs. Empty otherwise, so the stop proceeds.
 */
export function stopContinuationResponse(event: NormalizedHarnessEvent | null, missingEvidence: readonly unknown[], running?: StopRunning): string {
  if (event === null || event.kind !== 'turn.stopped' || event.nativeEventName !== 'Stop') return '';
  if (event.payload['stopHookActive'] !== false || event.payload['fullyIdle'] !== true || event.trigger !== 'model_stop') return '';
  const reason = stopReason(missingEvidence, running);
  return reason === null ? '' : JSON.stringify({ decision: 'continue', reason });
}

/**
 * Exact stdout. PreToolUse: nothing (Jevris makes no tool decision). PostToolUse and
 * PostInvocation: `{}`. PreInvocation: `{}` or one ephemeral message. Stop: a decision other
 * than "continue", so the stop always proceeds.
 */
export function protocolResponse(event: NormalizedHarnessEvent | null, outcome: HookOutcome): string {
  if (event === null) return '';
  const name = event.nativeEventName;
  if (name === 'PreToolUse') return '';
  if (name === 'Stop') return JSON.stringify({ decision: 'stop' });
  const text = contextText(outcome);
  if (name === 'PreInvocation' && text !== null) return JSON.stringify({ injectSteps: [{ ephemeralMessage: text }] });
  return '{}';
}

const common = {
  conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
  workspacePaths: ['/workspace/project'],
  transcriptPath: '/home/u/.gemini/antigravity/brain/ec33/transcript.jsonl',
  artifactDirectoryPath: '/home/u/.gemini/antigravity/brain/ec33',
  modelName: 'gemini-3.6-flash-medium',
};

export const FIXTURES: readonly AdapterFixture[] = [
  { id: 'antigravity.post-tool', hookKey: 'PostToolUse', native: { ...common, toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, stepIdx: 5, error: '' }, kind: 'tool.finished' },
  { id: 'antigravity.post-tool-failed', hookKey: 'PostToolUse', native: { ...common, toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, stepIdx: 6, error: 'exit status 1' }, kind: 'tool.failed' },
  { id: 'antigravity.pre-invocation', hookKey: 'PreInvocation', native: { ...common, invocationNum: 3, initialNumSteps: 10 }, kind: 'invocation.started' },
  { id: 'antigravity.post-invocation', hookKey: 'PostInvocation', native: { ...common, invocationNum: 3, initialNumSteps: 11 }, kind: 'invocation.finished' },
  { id: 'antigravity.stop', hookKey: 'Stop', native: { ...common, executionNum: 1, terminationReason: 'model_stop', error: '', fullyIdle: true }, kind: 'turn.stopped' },
  { id: 'antigravity.pre-tool', hookKey: 'PreToolUse', native: { ...common, toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } }, stepIdx: 19 }, kind: 'tool.proposed' },
  { id: 'antigravity.claude-shaped', native: { hook_event_name: 'PreToolUse' }, kind: null, refusal: 'FOREIGN_PROTOCOL' },
  { id: 'antigravity.decision-echo', native: { ...common, decision: 'allow' }, kind: null, refusal: 'FOREIGN_PROTOCOL' },
  { id: 'antigravity.unknown', hookKey: 'SessionStart', native: { ...common }, kind: null, refusal: 'UNKNOWN_EVENT' },
];
