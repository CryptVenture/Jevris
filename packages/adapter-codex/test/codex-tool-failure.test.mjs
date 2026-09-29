// G7 (harness parity audit): a Codex PostToolUse whose MCP result says isError is a failed tool
// call, with the first line of its text as evidence, the same as Claude Code's
// PostToolUseFailure. Bash and apply_patch results carry no exit status (Codex rust-v0.157.1),
// so they stay tool.finished whatever their text says. Also the SessionStart sources Codex
// documents (startup, resume, clear, compact) reach the envelope's trigger, where a capsule
// restore reads compact and resume.
import test from 'node:test';
import assert from 'node:assert/strict';

const codex = await import('../dist/index.js');
const { mcpToolError } = await import('../dist/protocol.js');

const base = { session_id: 'thr_1', transcript_path: null, cwd: '/work', model: 'gpt-5.5', hook_event_name: 'PostToolUse', turn_id: 't1', permission_mode: 'default', tool_use_id: 'call_9' };

test('an MCP result with isError true is tool.failed; its evidence keeps only the first error line', () => {
  const native = {
    ...base,
    tool_name: 'mcp__jevris__jevris_status',
    tool_input: {},
    tool_response: { content: [{ type: 'image', data: 'x' }, { type: 'text', text: '\nboom: the store is locked\nsecond line' }], isError: true },
  };
  const result = codex.normalize(native);
  assert.equal(result.ok, true);
  assert.equal(result.event.kind, 'tool.failed');
  assert.equal(result.event.nativeEventName, 'PostToolUse');
  assert.deepEqual(result.intent.evidence.diagnostics, [{ id: 'error', text: 'boom: the store is locked' }]);
  assert.equal(JSON.stringify(result.intent.evidence).includes('second line'), false, 'evidence keeps the first line only');
});

test('a successful MCP result, a Bash output and an apply_patch message stay tool.finished', () => {
  const ok = codex.normalize({ ...base, tool_name: 'mcp__x__y', tool_input: {}, tool_response: { content: [{ type: 'text', text: 'fine' }], isError: false } });
  assert.equal(ok.event.kind, 'tool.finished');
  const bash = codex.normalize({ ...base, tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: 'Process exited with code 1\nerror: failed' });
  assert.equal(bash.event.kind, 'tool.finished', 'no exit status in a Bash response; failure is never guessed from text');
  const patch = codex.normalize({ ...base, tool_name: 'apply_patch', tool_input: { command: '' }, tool_response: 'Failed to apply patch' });
  assert.equal(patch.event.kind, 'tool.finished');
});

test('mcpToolError: only isError true with a content list; the first text item, or empty', () => {
  assert.equal(mcpToolError({ content: [{ type: 'text', text: 'e' }], isError: true }), 'e');
  assert.equal(mcpToolError({ content: [], isError: true }), '');
  assert.equal(mcpToolError({ content: [{ type: 'text', text: 'e' }], isError: 'true' }), null);
  assert.equal(mcpToolError({ isError: true }), null);
  assert.equal(mcpToolError('error'), null);
});

test('SessionStart: every documented Codex source reaches the trigger (compact and resume restore a capsule)', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const result = codex.normalize({ session_id: 'thr_1', transcript_path: null, cwd: '/work', model: 'gpt-5.5', hook_event_name: 'SessionStart', source, permission_mode: 'default' });
    assert.equal(result.ok, true, source);
    assert.equal(result.event.kind, 'session.started');
    assert.equal(result.event.trigger, source);
  }
});
