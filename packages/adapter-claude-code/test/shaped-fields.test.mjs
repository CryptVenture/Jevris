// B's LOW 30 (access limits R69): the ids a hook event keeps, a permission mode, a model and an
// agent type, are kept only in their id shape, so free text in one of them is dropped, never kept.
import test from 'node:test';
import assert from 'node:assert/strict';

const claude = await import('../dist/index.js');
const codex = await import('@jevris/adapter-codex');

const base = { hook_event_name: 'Stop', session_id: 'ses_1', transcript_path: '/work/ses_1.jsonl', cwd: '/work' };
const TEXT = 'JEVRIS-CANARY-7f3a free text';

test('permission mode, model and agent type are kept in their id shape and dropped otherwise', () => {
  for (const adapter of [claude, codex]) {
    const kept = adapter.normalize({ ...base, permission_mode: 'acceptEdits', model: 'claude-opus-5-5[1m]', agent_type: 'plugin:reviewer', agent_id: 'a1' });
    assert.equal(kept.ok, true);
    assert.deepEqual([kept.event.permissionMode, kept.event.model, kept.event.payload.agentType], ['acceptEdits', 'claude-opus-5-5[1m]', 'plugin:reviewer']);
    for (const model of ['haiku', 'gpt-5.5', 'anthropic/claude-sonnet-4-5']) assert.equal(adapter.normalize({ ...base, model }).event.model, model, model);
    const dropped = adapter.normalize({ ...base, permission_mode: TEXT, model: TEXT, agent_type: TEXT, agent_id: 'a1' });
    assert.equal(dropped.ok, true, 'a malformed id never fails the event');
    assert.deepEqual([dropped.event.permissionMode, dropped.event.model, dropped.event.payload.agentType ?? null], [null, null, null]);
    assert.doesNotMatch(JSON.stringify(dropped.event), /CANARY/);
  }
});

test('a Bedrock ARN model keeps no account id; the task tool route inputs are shape-checked, and a named but unreadable model is kept as unreadable-model', () => {
  const arn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123';
  const event = claude.normalize({ ...base, model: arn });
  assert.equal(event.event.model, 'bedrock-arn');
  assert.doesNotMatch(JSON.stringify(event.event), /123456789012/);
  const call = (toolInput) => claude.normalize({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: toolInput });
  const routed = call({ description: 'd', prompt: 'p', subagent_type: 'general-purpose', model: arn });
  assert.equal(routed.ok, true);
  assert.deepEqual([routed.event.payload.subagentType, routed.event.payload.requestedModel], ['general-purpose', 'bedrock-arn']);
  assert.doesNotMatch(JSON.stringify(routed.event), /123456789012/);
  const text = call({ description: 'd', prompt: 'p', subagent_type: TEXT, model: TEXT });
  assert.deepEqual([text.event.payload.subagentType ?? null, text.event.payload.requestedModel], [null, 'unreadable-model'], 'a named model stays explicit (C), never its text');
  assert.doesNotMatch(JSON.stringify(text.event), /CANARY/);
  for (const model of [42, { id: 'x' }, 'x'.repeat(200)]) assert.equal(call({ description: 'd', prompt: 'p', subagent_type: 'general-purpose', model }).event.payload.requestedModel, 'unreadable-model', JSON.stringify(model).slice(0, 20));
  for (const model of [undefined, null, '', '  ']) assert.equal(call({ description: 'd', prompt: 'p', subagent_type: 'general-purpose', model }).event.payload.requestedModel ?? null, null, `absent: ${JSON.stringify(model)}`);
  assert.equal(call({ description: 'd', prompt: 'p', subagent_type: 'general-purpose', model: 'sonnet' }).event.payload.requestedModel, 'sonnet');
});
