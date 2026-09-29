// Subagents: every adapter reports a subagent's event one way. `sessionId` is the parent
// session, `agentId` names the subagent and `parentSessionId` repeats the parent; session-level
// kinds become worker kinds, so a subagent's prompt, stop or end is never read as the parent's.
// Claude Code and Codex name a subagent by agent_id on the parent's session_id; Kilo and
// OpenCode run it as a child session whose session.created names its parent. The verification
// gate answers only the parent's Stop. Each pair below shows the parent's own event first. No
// real harness runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const CORES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const cores = await Promise.all(CORES.map(async (name) => ({ name, core: await import(join(root, name, 'dist', 'common.js')) })));
const claude = await import(join(root, 'adapter-claude-code', 'dist', 'index.js'));
const codex = await import(join(root, 'adapter-codex', 'dist', 'index.js'));
const plugins = await Promise.all(['adapter-kilocode', 'adapter-opencode'].map(async (name) => ({ name, adapter: await import(join(root, name, 'dist', 'index.js')) })));

function event(adapter, native) {
  const result = adapter.normalize(native);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

const scoped = (e) => ({ kind: e.kind, sessionId: e.sessionId, agentId: e.agentId, parentSessionId: e.parentSessionId });

for (const { name, core } of cores) {
  test(`${name}: subagentScope leaves the session's own events alone and scopes a subagent's under its parent`, () => {
    assert.deepEqual(core.subagentScope('turn.stopped', 's1', null, null), { kind: 'turn.stopped', sessionId: 's1', agentId: null, parentSessionId: null });
    assert.deepEqual(core.subagentScope('turn.stopped', 'child', 'child', 's1'), { kind: 'worker.finished', sessionId: 's1', agentId: 'child', parentSessionId: 's1' });
    // A subagent id equal to the parent's is the session itself.
    assert.deepEqual(core.subagentScope('task.requested', 's1', 's1', 's1'), { kind: 'task.requested', sessionId: 's1', agentId: 's1', parentSessionId: null });
    const kinds = [
      ['session.started', 'worker.started'],
      ['task.requested', 'worker.prompted'],
      ['turn.stopped', 'worker.finished'],
      ['context.compacting', 'worker.compacting'],
      ['context.compacted', 'worker.compacted'],
      ['session.ended', 'worker.ended'],
      ['turn.failed', 'worker.failed'],
      ['tool.proposed', 'tool.proposed'],
      ['tool.finished', 'tool.finished'],
      ['message.completed', 'message.completed'],
      ['worker.started', 'worker.started'],
    ];
    for (const [own, sub] of kinds) {
      assert.equal(core.subagentScope(own, 's1', null, null).kind, own, `${own} stays for the session's own event`);
      assert.equal(core.subagentScope(own, 's1', 'a1', 's1').kind, sub, `${own} from a subagent`);
    }
  });
}

test("Claude Code: a subagent's hooks carry agent_id on the parent's session_id and report it as a subagent", () => {
  const base = { session_id: 'ses_1', transcript_path: '/home/u/.claude/projects/p/ses_1.jsonl', cwd: '/work', permission_mode: 'default' };
  const sub = { agent_id: 'a1', agent_type: 'Explore' };
  for (const native of [
    { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: { file_path: '/work/a.ts' }, tool_response: {} },
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_3', tool_input: { description: 'nested', prompt: 'look', subagent_type: 'Explore' } },
  ]) {
    const own = event(claude, native).event;
    assert.deepEqual(scoped(own), { kind: own.kind, sessionId: 'ses_1', agentId: null, parentSessionId: undefined }, `${native.hook_event_name} in the parent`);
    assert.equal(Object.hasOwn(own, 'parentSessionId'), false, 'the parent session carries no parentSessionId key');
    const e = event(claude, { ...native, ...sub }).event;
    assert.deepEqual(scoped(e), { kind: own.kind, sessionId: 'ses_1', agentId: 'a1', parentSessionId: 'ses_1' }, `${native.hook_event_name} in a subagent`);
    assert.equal(e.payload.agentType, 'Explore');
    assert.notEqual(e.dedupKey, own.dedupKey);
  }
  const start = event(claude, { ...base, hook_event_name: 'SubagentStart', ...sub }).event;
  assert.deepEqual(scoped(start), { kind: 'worker.started', sessionId: 'ses_1', agentId: 'a1', parentSessionId: 'ses_1' });
  const stop = event(claude, { ...base, hook_event_name: 'SubagentStop', stop_hook_active: false, ...sub }).event;
  assert.deepEqual(scoped(stop), { kind: 'worker.finished', sessionId: 'ses_1', agentId: 'a1', parentSessionId: 'ses_1' });
});

test("Codex: a subagent thread's hooks carry agent_id on the root session_id; its prompt and compaction are worker events", () => {
  const base = { session_id: 'thr_1', transcript_path: null, cwd: '/work', model: 'gpt-5.5', permission_mode: 'default' };
  const sub = { agent_id: 'thr_child', agent_type: 'worker' };
  const prompt = { ...base, hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'fix the test' };
  const own = event(codex, prompt);
  assert.equal(own.event.kind, 'task.requested');
  assert.deepEqual(own.intent.task, { objective: 'fix the test' }, "the parent's prompt is a task");
  const child = event(codex, { ...prompt, ...sub });
  assert.deepEqual(scoped(child.event), { kind: 'worker.prompted', sessionId: 'thr_1', agentId: 'thr_child', parentSessionId: 'thr_1' });
  assert.equal(child.intent?.task, undefined, "a subagent's prompt is not a new task for the parent");
  const tool = { ...base, hook_event_name: 'PostToolUse', turn_id: 't1', tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'ls' }, tool_response: 'ok' };
  assert.deepEqual(scoped(event(codex, tool).event), { kind: 'tool.finished', sessionId: 'thr_1', agentId: null, parentSessionId: undefined });
  assert.deepEqual(scoped(event(codex, { ...tool, ...sub }).event), { kind: 'tool.finished', sessionId: 'thr_1', agentId: 'thr_child', parentSessionId: 'thr_1' });
  const compact = { ...base, hook_event_name: 'PreCompact', trigger: 'auto' };
  assert.equal(event(codex, compact).event.kind, 'context.compacting');
  assert.equal(event(codex, { ...compact, ...sub }).event.kind, 'worker.compacting');
});

test("the verification gate answers only the parent's Stop, never a subagent's", () => {
  const missing = ['test'];
  const claudeBase = { session_id: 'ses_1', transcript_path: '/home/u/.claude/projects/p/ses_1.jsonl', cwd: '/work', stop_hook_active: false };
  const parentStop = event(claude, { ...claudeBase, hook_event_name: 'Stop' }).event;
  assert.equal(JSON.parse(claude.stopContinuationResponse(parentStop, missing)).decision, 'block', "the parent's Stop is held for missing evidence");
  const subagentStop = event(claude, { ...claudeBase, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' }).event;
  assert.equal(claude.stopContinuationResponse(subagentStop, missing), '', "a subagent's stop is never held");
  const strayStop = event(claude, { ...claudeBase, hook_event_name: 'Stop', agent_id: 'a1' }).event;
  assert.equal(strayStop.kind, 'worker.finished');
  assert.equal(claude.stopContinuationResponse(strayStop, missing), '', 'a Stop that names a subagent is the subagent finishing');

  const codexBase = { session_id: 'thr_1', transcript_path: null, cwd: '/work', model: 'gpt-5.5', turn_id: 't1', stop_hook_active: false };
  const codexStop = event(codex, { ...codexBase, hook_event_name: 'Stop' }).event;
  assert.equal(JSON.parse(codex.stopContinuationResponse(codexStop, missing)).decision, 'block');
  const codexSub = event(codex, { ...codexBase, hook_event_name: 'SubagentStop', agent_id: 'thr_child', agent_type: 'worker' }).event;
  assert.equal(codex.stopContinuationResponse(codexSub, missing), '');
  assert.equal(codex.protocolResponse(codexSub, { kind: 'observe' }), '{}', 'Codex still gets the JSON it requires, with no decision');
});

for (const { name, adapter } of plugins) {
  test(`${name}: a child session's session.created names its parent and becomes worker.started under it`, () => {
    const created = (info) => ({ hookKey: 'event', event: { type: 'session.created', properties: { info } } });
    const own = event(adapter, created({ id: 'ses_parent', title: 'main' })).event;
    assert.deepEqual(scoped(own), { kind: 'session.started', sessionId: 'ses_parent', agentId: null, parentSessionId: undefined });
    const child = event(adapter, created({ id: 'ses_child', parentID: 'ses_parent', title: 'explore' })).event;
    assert.deepEqual(scoped(child), { kind: 'worker.started', sessionId: 'ses_parent', agentId: 'ses_child', parentSessionId: 'ses_parent' });
    assert.equal(child.payload.agentType, undefined, 'a title without the task tool form gives no type');
    // P13 (D): the task tool titles a child "<description> (@<agent> subagent)"; only the agent name is kept.
    const typed = event(adapter, created({ id: 'ses_child2', parentID: 'ses_parent', title: 'CANARY_description_9d2 (@explore subagent)' })).event;
    assert.equal(typed.kind, 'worker.started');
    assert.equal(typed.payload.agentType, 'explore');
    assert.equal(JSON.stringify(typed).includes('CANARY_description_9d2'), false, 'the description is never kept');
    const parentTitled = event(adapter, created({ id: 'ses_parent2', title: 'x (@explore subagent)' })).event;
    assert.equal(parentTitled.payload.agentType, undefined, "a session's own event carries no type");
    for (const title of ['x (@ subagent)', 'x (@a b subagent)', `x (@${'a'.repeat(65)} subagent)`, 'x (@explore subagent) tail', 42]) {
      assert.equal(event(adapter, created({ id: 'ses_c3', parentID: 'ses_parent', title })).event.payload.agentType, undefined, String(title));
    }
  });

  test(`${name}: the parent a shim adds scopes a child's prompt, idle and tools; the parent's own stay its own`, () => {
    const chat = { hookKey: 'chat.message', input: { sessionID: 'ses_child', agent: 'explore', messageID: 'm1' }, output: { parts: [{ type: 'text', text: 'look around' }] } };
    const ownChat = event(adapter, { ...chat, input: { ...chat.input, sessionID: 'ses_parent', agent: 'build' } });
    assert.equal(ownChat.event.kind, 'task.requested');
    assert.equal(ownChat.event.agentId, 'build', "the parent's agent name is kept as it was");
    assert.deepEqual(ownChat.intent.task, { objective: 'look around' });
    const childChat = event(adapter, { ...chat, parentSessionID: 'ses_parent' });
    assert.deepEqual(scoped(childChat.event), { kind: 'worker.prompted', sessionId: 'ses_parent', agentId: 'ses_child', parentSessionId: 'ses_parent' });
    assert.equal(childChat.event.payload.agentType, 'explore');
    assert.equal(childChat.intent?.task, undefined, "a child's prompt is not a new task for the parent");
    const idle = { hookKey: 'event', event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } };
    assert.deepEqual(scoped(event(adapter, idle).event), { kind: 'turn.stopped', sessionId: 'ses_child', agentId: null, parentSessionId: undefined }, 'no parent known: its own stop');
    assert.deepEqual(scoped(event(adapter, { ...idle, parentSessionID: 'ses_parent' }).event), { kind: 'worker.finished', sessionId: 'ses_parent', agentId: 'ses_child', parentSessionId: 'ses_parent' });
    const tool = { hookKey: 'tool.execute.before', input: { tool: 'read', sessionID: 'ses_child', callID: 'call_1' }, output: { args: { filePath: '/w/a.ts' } } };
    assert.deepEqual(scoped(event(adapter, { ...tool, parentSessionID: 'ses_parent' }).event), { kind: 'tool.proposed', sessionId: 'ses_parent', agentId: 'ses_child', parentSessionId: 'ses_parent' });
  });
}

test('the plugin shim remembers each child session\'s parent and adds it to the child\'s later events, within a bound', async () => {
  const core = cores.find(({ name }) => name === 'adapter-kilocode').core;
  const kilo = plugins.find(({ name }) => name === 'adapter-kilocode').adapter;
  const sent = [];
  const hooks = core.createPluginHooks({ harness: 'kilocode', forward: async (text) => (sent.push(JSON.parse(text)), '') });
  const last = () => sent[sent.length - 1];
  const created = (id, parentID) => ({ event: { type: 'session.created', properties: { info: parentID === undefined ? { id } : { id, parentID } } } });
  const tool = (sessionID, callID) => ({ tool: 'read', sessionID, callID });

  await hooks.event(created('ses_parent'));
  await hooks['tool.execute.before'](tool('ses_parent', 'c0'), { args: {} });
  assert.equal(Object.hasOwn(last(), 'parentSessionID'), false, "the parent's own tool call names no parent");

  await hooks.event(created('ses_child', 'ses_parent'));
  assert.equal(last().parentSessionID, 'ses_parent');
  await hooks['tool.execute.before'](tool('ses_child', 'c1'), { args: {} });
  assert.equal(last().parentSessionID, 'ses_parent', "the child's tool call carries its parent");
  const forwarded = event(kilo, last()).event;
  assert.deepEqual(scoped(forwarded), { kind: 'tool.proposed', sessionId: 'ses_parent', agentId: 'ses_child', parentSessionId: 'ses_parent' }, 'the launcher reads the same scope from what the shim sent');
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } });
  assert.equal(event(kilo, last()).event.kind, 'worker.finished');
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_parent' } } });
  assert.equal(event(kilo, last()).event.kind, 'turn.stopped', "the parent's idle is still its stop");

  // Bounded: past PARENT_MEMORY children the oldest is forgotten, the newest kept.
  for (let i = 0; i < core.PARENT_MEMORY; i += 1) await hooks.event(created(`ses_c${i}`, 'ses_parent'));
  await hooks['tool.execute.before'](tool('ses_child', 'c2'), { args: {} });
  assert.equal(Object.hasOwn(last(), 'parentSessionID'), false, 'the oldest child is forgotten');
  await hooks['tool.execute.before'](tool(`ses_c${core.PARENT_MEMORY - 1}`, 'c3'), { args: {} });
  assert.equal(last().parentSessionID, 'ses_parent', 'the newest child is remembered');
});
