// How a repeated-failure line reaches the person on each harness, once (JEV-0062). The sidecar now takes a waiting
// line after every subscriber has answered (see pending-advice-held.test.mjs), so this holds the delivery
// itself to what it was: the line arrives on the harness's own channel (a `systemMessage` on Claude Code and
// Codex, the system prompt on Kilo and OpenCode, an ephemeral message on Antigravity), is taken when it is shown, is
// not shown again by a later event, and a redelivery of the event that showed it gets the same answer
// (DUPLICATE_REPLAYED) without taking or showing anything more.
// Through a real sidecar and the real hook launcher in a sandbox
// (temporary home, no keychain, no Jev: the rules settle an equal failure).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';
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
    assert.deepEqual(failureLines(box.hook('claude', failure('toolu_cc1'), SLOW)), []);
    const second = box.hook('claude', failure('toolu_cc2'), SLOW);
    assert.equal(adviceOf(second).key, 'systemMessage', 'Claude Code shows it to the person, not in the model\'s context');
    assert.equal(failureLines(second).length, 1, second.stdout);
    // The redelivery of that event (same tool use) replays the answer and takes nothing more.
    const replay = box.hook('claude', failure('toolu_cc2'), SLOW);
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.equal(replay.stdout, second.stdout, 'the same answer');
    assert.deepEqual(failureLines(box.hook('claude', next(), SLOW)), [], 'a later event does not show the line again');
    assert.deepEqual(failureLines(box.hook('claude', next(), SLOW)), [], 'and again');
  }

  // Codex: only an MCP result with isError is a failure. Same channel, same rules.
  {
    const session = `cx-${uid()}`;
    const input = { q: `lookup-${uid()}` };
    const base = { session_id: session, transcript_path: null, cwd: ws, model: 'gpt-6.1-sol', turn_id: 't1', permission_mode: 'default' };
    const mcp = (callId) => ({ ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__e2e__lookup', tool_use_id: callId, tool_input: input, tool_response: { content: [{ type: 'text', text: 'boom: the store is locked' }], isError: true } });
    const next = () => ({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: `call_${uid()}`, tool_input: { command: `ls ${uid()}` }, tool_response: 'a' });
    assert.deepEqual(failureLines(box.hook('codex', mcp('call_cx1'), SLOW)), []);
    const second = box.hook('codex', mcp('call_cx2'), SLOW);
    assert.equal(adviceOf(second).key, 'systemMessage');
    assert.equal(failureLines(second).length, 1, second.stdout);
    const replay = box.hook('codex', mcp('call_cx2'), SLOW);
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.equal(replay.stdout, second.stdout);
    assert.deepEqual(failureLines(box.hook('codex', next(), SLOW)), []);
  }

  // Kilo Code and OpenCode: a tool event cannot show a line, so it waits for the next message, on the system prompt.
  for (const harness of ['kilo', 'opencode']) {
    const session = `${harness}-${uid()}`;
    const command = `npm run channels-${uid()}`;
    const bash = () => ({ hookKey: 'tool.execute.after', input: { tool: 'bash', sessionID: session, callID: `call_${uid()}`, args: { command } }, output: { title: command, output: 'FAIL src/a.test.js', metadata: { exit: 1 } } });
    const chat = (messageId) => ({ hookKey: 'chat.message', input: { sessionID: session, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, messageID: messageId }, output: { message: {}, parts: [{ type: 'text', text: 'what is the status of the work' }] } });
    for (let i = 0; i < 2; i += 1) assert.deepEqual(adviceOf(box.hook(harness, bash(), SLOW)).lines, [], `${harness}: a tool event shows nothing`);
    const messageId = `msg_${uid()}`;
    const shown = box.hook(harness, chat(messageId), SLOW);
    assert.equal(adviceOf(shown).key, 'system', `${harness}: the system prompt of that turn`);
    assert.equal(failureLines(shown).length, 1, shown.stdout);
    const replay = box.hook(harness, chat(messageId), SLOW);
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.equal(replay.stdout, shown.stdout, `${harness}: the redelivery gets the answer the first delivery got`);
    assert.deepEqual(failureLines(box.hook(harness, chat(`msg_${uid()}`), SLOW)), [], `${harness}: once`);
  }

  // Antigravity: a PostToolUse shows nothing; the line is the ephemeral message before the next invocation.
  {
    const conversationId = `agy-${uid()}`;
    const base = { conversationId, workspacePaths: [ws], transcriptPath: `${ws}/.t.jsonl`, modelName: 'gemini-3.6-flash-medium' };
    const command = `npm run channels-${uid()}`;
    const failure = () => ({ ...base, toolCall: { name: 'run_command', args: { CommandLine: command } }, stepIdx: (seq += 1), error: 'exit status 1' });
    const invocation = (n) => ({ ...base, invocationNum: n, initialNumSteps: 10 });
    for (let i = 0; i < 2; i += 1) assert.equal(box.hook('agy', failure(), { ...SLOW, event: 'PostToolUse' }).stdout.trim(), '{}', 'PostToolUse shows nothing');
    const n = (seq += 1);
    const shown = box.hook('agy', invocation(n), { ...SLOW, event: 'PreInvocation' });
    assert.equal(adviceOf(shown).key, 'injectSteps', 'an ephemeral message before the invocation');
    assert.equal(failureLines(shown).length, 1, shown.stdout);
    const replay = box.hook('agy', invocation(n), { ...SLOW, event: 'PreInvocation' });
    assert.equal(replay.reason, 'DUPLICATE_REPLAYED', replay.stderr);
    assert.equal(replay.stdout, shown.stdout);
    assert.deepEqual(failureLines(box.hook('agy', invocation((seq += 1)), { ...SLOW, event: 'PreInvocation' })), [], 'once');
  }
});
