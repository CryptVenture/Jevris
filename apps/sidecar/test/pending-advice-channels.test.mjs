// How a repeated-failure line reaches the person on each harness, once (JEV-0062). The sidecar now takes a waiting
// line after every subscriber has answered (see pending-advice-held.test.mjs), so this holds the delivery
// itself to what it was: the line arrives on the harness's own channel (a `systemMessage` on Claude Code and
// Codex, the system prompt on Kilo and OpenCode, an ephemeral message on Antigravity), is taken when it is shown, is
// not shown again by a later event, and a redelivery of the event that showed it gets the same answer
// (DUPLICATE_REPLAYED) without taking or showing anything more.
// Through a real sidecar and the real hook launcher in a sandbox
// (temporary home, no keychain, no Jev: the rules settle an equal failure). The sidecar defers a subscriber that was slow on the
// event before (a cold first event on a slow host), and a deferred answer shows and takes nothing, so each harness is warmed first
// and an event that showed nothing because it was deferred is followed by the next one (test/acceptance/hook-settled.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { untilShown, warmHooks } from '../../../test/acceptance/hook-settled.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const RULES = /this failure has come back (\d+) times; the next most useful evidence is /;
const SLOW = { extraEnv: { JEVRIS_HOOK_DEADLINE_MS: '4000' } };
let seq = 0;
const uid = () => `${process.pid}-${(seq += 1)}`;

/** The advice lines of a hook answer, whatever channel the harness renders them on, and the channel's key. */
function adviceOf(hook) {
  assert.equal(hook.code, 0, `the hook exited ${hook.code}: ${hook.stderr}`);
  assert.doesNotMatch(hook.reason ?? '', /DEADLINE|TIMEOUT/, `the hook ran out of time (${hook.reason}): the machine is too loaded for the 4 s hook deadline`);
  if (hook.stdout.trim() === '') return { key: null, lines: [] };
  const json = JSON.parse(hook.stdout);
  const key = Object.keys(json)[0] ?? null;
  const text = typeof json.systemMessage === 'string' ? json.systemMessage : Array.isArray(json.system) ? json.system.join('\n') : Array.isArray(json.injectSteps) ? json.injectSteps.map((step) => step.ephemeralMessage).join('\n') : '';
  return { key: key === null || !['systemMessage', 'system', 'injectSteps'].includes(key) ? null : key, lines: text.split('\n').map((line) => line.trim()).filter(Boolean) };
}
const failureLines = (hook) => adviceOf(hook).lines.filter((line) => RULES.test(line));
const showsLine = (hook) => failureLines(hook).length > 0;
const named = (hook) => `${hook.reason}: ${hook.stdout.trim().slice(0, 200) || '(empty)'}`;

test('the repeated-failure line arrives once on every harness, and a redelivery of the event that showed it replays that answer', { timeout: 180_000, skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const ws = box.work;

  // Claude Code: the same failed call twice. The rules settle it, so the line is the second failure's own answer, a systemMessage.
  {
    const session = `cc-${uid()}`;
    const input = { command: `npm run channels-${uid()}` };
    const failure = (toolUseId, error = 'Exit code 1\nsame') => ({ session_id: session, transcript_path: `${ws}/.t.jsonl`, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: toolUseId, tool_input: input, error, is_interrupt: false });
    const next = () => ({ session_id: session, transcript_path: `${ws}/.t.jsonl`, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: `toolu_${uid()}`, tool_input: { command: `ls ${uid()}` }, tool_response: { stdout: 'a', stderr: '', interrupted: false } });
    warmHooks(box, 'claude', () => ({ ...next(), session_id: `warm-${uid()}` }), SLOW);
    assert.deepEqual(failureLines(box.hook('claude', failure('toolu_cc1'), SLOW)), []);
    // The second failure shows the line itself; a deferred second failure shows nothing and takes nothing, and the next event does.
    const shown = untilShown(box, 'claude', (n) => (n === 1 ? failure('toolu_cc2') : next()), showsLine, SLOW);
    assert.equal(adviceOf(shown.hook).key, 'systemMessage', 'Claude Code shows it to the person, not in the model\'s context');
    assert.equal(failureLines(shown.hook).length, 1, named(shown.hook));
    // The redelivery of that event (same tool use) replays the answer and takes nothing more.
    const replay = box.hook('claude', shown.native, SLOW);
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.equal(replay.stdout, shown.hook.stdout, 'the same answer');
    const later = box.hook('claude', next(), SLOW);
    assert.deepEqual(failureLines(later), [], `a later event does not show the line again: ${named(later)}`);
  }

  // Codex: only an MCP result with isError is a failure. Same channel, same rules.
  {
    const session = `cx-${uid()}`;
    const input = { q: `lookup-${uid()}` };
    const base = (id = session) => ({ session_id: id, transcript_path: null, cwd: ws, model: 'gpt-6.1-sol', turn_id: 't1', permission_mode: 'default' });
    const mcp = (callId) => ({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'mcp__e2e__lookup', tool_use_id: callId, tool_input: input, tool_response: { content: [{ type: 'text', text: 'boom: the store is locked' }], isError: true } });
    const next = (id = session) => ({ ...base(id), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: `call_${uid()}`, tool_input: { command: `ls ${uid()}` }, tool_response: 'a' });
    warmHooks(box, 'codex', () => next(`warm-${uid()}`), SLOW);
    assert.deepEqual(failureLines(box.hook('codex', mcp('call_cx1'), SLOW)), []);
    const shown = untilShown(box, 'codex', (n) => (n === 1 ? mcp('call_cx2') : next()), showsLine, SLOW);
    assert.equal(adviceOf(shown.hook).key, 'systemMessage');
    assert.equal(failureLines(shown.hook).length, 1, named(shown.hook));
    const replay = box.hook('codex', shown.native, SLOW);
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.equal(replay.stdout, shown.hook.stdout);
    const later = box.hook('codex', next(), SLOW);
    assert.deepEqual(failureLines(later), [], `once: ${named(later)}`);
  }

  // Kilo Code and OpenCode: a tool event cannot show a line, so it waits for the next message, on the system prompt.
  for (const harness of ['kilo', 'opencode']) {
    const session = `${harness}-${uid()}`;
    const command = `npm run channels-${uid()}`;
    const bash = () => ({ hookKey: 'tool.execute.after', input: { tool: 'bash', sessionID: session, callID: `call_${uid()}`, args: { command } }, output: { title: command, output: 'FAIL src/a.test.js', metadata: { exit: 1 } } });
    const chat = (messageId, id = session) => ({ hookKey: 'chat.message', input: { sessionID: id, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, messageID: messageId }, output: { message: {}, parts: [{ type: 'text', text: 'what is the status of the work' }] } });
    warmHooks(box, harness, () => chat(`msg_${uid()}`, `warm-${uid()}`), SLOW);
    for (let i = 0; i < 2; i += 1) assert.deepEqual(adviceOf(box.hook(harness, bash(), SLOW)).lines, [], `${harness}: a tool event shows nothing`);
    const shown = untilShown(box, harness, () => chat(`msg_${uid()}`), showsLine, SLOW);
    assert.equal(adviceOf(shown.hook).key, 'system', `${harness}: the system prompt of that turn`);
    assert.equal(failureLines(shown.hook).length, 1, named(shown.hook));
    const replay = box.hook(harness, shown.native, SLOW);
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.equal(replay.stdout, shown.hook.stdout, `${harness}: the redelivery gets the answer the first delivery got`);
    const later = box.hook(harness, chat(`msg_${uid()}`), SLOW);
    assert.deepEqual(failureLines(later), [], `${harness}: once: ${named(later)}`);
  }

  // Antigravity: a PostToolUse shows nothing; the line is the ephemeral message before the next invocation.
  {
    const conversationId = `agy-${uid()}`;
    const base = (id = conversationId) => ({ conversationId: id, workspacePaths: [ws], transcriptPath: `${ws}/.t.jsonl`, modelName: 'gemini-3.6-flash-medium' });
    const command = `npm run channels-${uid()}`;
    const failure = () => ({ ...base(), toolCall: { name: 'run_command', args: { CommandLine: command } }, stepIdx: (seq += 1), error: 'exit status 1' });
    const invocation = (id = conversationId) => ({ ...base(id), invocationNum: (seq += 1), initialNumSteps: 10 });
    const post = { ...SLOW, event: 'PostToolUse' };
    const pre = { ...SLOW, event: 'PreInvocation' };
    warmHooks(box, 'agy', () => invocation(`warm-${uid()}`), pre);
    for (let i = 0; i < 2; i += 1) assert.equal(box.hook('agy', failure(), post).stdout.trim(), '{}', 'PostToolUse shows nothing');
    const shown = untilShown(box, 'agy', () => invocation(), showsLine, pre);
    assert.equal(adviceOf(shown.hook).key, 'injectSteps', 'an ephemeral message before the invocation');
    assert.equal(failureLines(shown.hook).length, 1, named(shown.hook));
    const replay = box.hook('agy', shown.native, pre);
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.equal(replay.stdout, shown.hook.stdout);
    const later = box.hook('agy', invocation(), pre);
    assert.deepEqual(failureLines(later), [], `once: ${named(later)}`);
  }
});
