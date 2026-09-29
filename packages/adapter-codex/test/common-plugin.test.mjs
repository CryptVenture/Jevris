// HCF-01: the Kilo/OpenCode plugin half of the shared adapter core (src/common.ts, byte-identical
// in all five packages), and the subagent normalisers C's route reads, exercised from every
// package's own build. Each package's dist/common.js is covered, not only the copy Kilo and
// OpenCode load. No real harness runs here, and no launcher is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const PACKAGES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const cores = await Promise.all(PACKAGES.map(async (name) => ({ name, core: await import(join(root, name, 'dist', 'common.js')) })));

const SPEC = { kind: 'tool.proposed', blocking: true, responseRequired: true };

/** An object whose `key` getter throws: a hostile harness value the hooks must survive. */
function throwing(key, base = {}) {
  const value = { ...base };
  Object.defineProperty(value, key, { enumerable: true, get() { throw new Error('hostile'); } });
  return value;
}

function recorder(core, answer = () => '') {
  const sent = [];
  const hooks = core.createPluginHooks({
    harness: 'opencode',
    forward: async (text, wait) => {
      const native = JSON.parse(text);
      sent.push({ native, wait });
      return wait ? answer(native) : '';
    },
  });
  return { sent, hooks };
}

for (const { name, core } of cores) {
  test(`${name}: spawn_agent and task normalisers fill subagentType and requestedModel, never other input`, () => {
    const spawn = (toolInput) => core.commandHookParts('codex', 'PreToolUse', SPEC, { session_id: 's1', tool_name: 'spawn_agent', tool_input: toolInput }).event.payload;
    assert.equal(spawn({ message: 'secret', agent_type: 'explorer' }).subagentType, 'explorer');
    assert.equal(spawn({ message: 'secret' }).subagentType, 'default', "a spawn without agent_type runs Codex's default role");
    assert.equal(spawn({ subagent_type: 'worker', agent_type: 'explorer' }).subagentType, 'worker');
    assert.equal(spawn({ message: 'x', model: 'gpt-6-luna' }).requestedModel, 'gpt-6-luna');
    assert.equal(spawn({ message: 'x', model: 'free text model' }).requestedModel, 'unreadable-model', 'a named model stays explicit, never its text (C)');
    assert.equal(spawn({ message: 'x', model: '' }).requestedModel, undefined, 'an empty model is no model');
    assert.equal(JSON.stringify(spawn({ message: 'secret text' })).includes('secret text'), false);
    const bash = core.commandHookParts('codex', 'PreToolUse', SPEC, { session_id: 's1', tool_name: 'Bash', tool_input: { agent_type: 'explorer' } }).event.payload;
    assert.equal(bash.subagentType, undefined, 'agent_type counts only on spawn_agent');

    const before = (tool, args, key = 'tool.execute.before') =>
      core.pluginEvent('opencode', { hookKey: key, input: { tool, sessionID: 'ses_1', callID: 'call_1' }, output: { args } }, key);
    const task = before('task', { description: 'secret', prompt: 'secret', subagent_type: 'explore', model: 'claude-sonnet-4-5' });
    assert.equal(task.ok, true);
    assert.equal(task.event.payload.subagentType, 'explore');
    assert.equal(task.event.payload.requestedModel, 'claude-sonnet-4-5');
    assert.equal(JSON.stringify(task.event).includes('secret'), false);
    assert.equal(before('task', { prompt: 'x' }).event.payload.subagentType, undefined);
    assert.equal(before('task', { subagent_type: 'explore', model: { id: 'x' } }).event.payload.requestedModel, 'unreadable-model');
    assert.equal(before('task', { subagent_type: 'explore' }).event.payload.requestedModel, undefined);
    assert.equal(before('bash', { subagent_type: 'explore', model: 'm' }).event.payload.subagentType, undefined, 'only the task tool');
    assert.equal(before('task', { subagent_type: 'explore' }, 'tool.execute.after').event.payload.subagentType, undefined, 'only before the call');

    assert.equal(core.failureEvidence('bash', { not: 'text' }).required[0].available, false, 'an error that is not text has no evidence line');
  });

  test(`${name}: plugin bus events read errored tool parts, child titles and failed bash exits`, () => {
    const part = (state, type = 'tool') => core.pluginEvent('kilocode', { event: { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { id: 'prt_1', type, callID: 'call_3', tool: 'edit', state } } } }, 'event');
    const failed = part({ status: 'error', error: 'Error: not found\nstack' });
    assert.equal(failed.ok, true);
    assert.equal(failed.event.kind, 'tool.failed');
    assert.equal(failed.event.toolUseId, 'call_3');
    assert.equal(failed.event.toolName, 'edit');
    assert.equal(part({ status: 'completed' }).reasonCode, 'UNKNOWN_EVENT');
    assert.equal(part('state', 'tool').reasonCode, 'UNKNOWN_EVENT');
    assert.equal(part({ status: 'error' }, 'text').reasonCode, 'UNKNOWN_EVENT');

    const created = (info) => core.pluginEvent('opencode', { event: { type: 'session.created', properties: { info } } }, 'event');
    const child = created({ id: 'ses_child', parentID: 'ses_top', title: 'look around (@explore subagent)' });
    assert.equal(child.event.parentSessionId, 'ses_top');
    assert.equal(child.event.payload.agentType, 'explore');
    assert.equal(created({ id: 'ses_child', parentID: 'ses_top', title: 'plain title' }).event.payload.agentType, undefined);
    assert.equal(created({ id: 'ses_top', title: 'x (@explore subagent)' }).event.payload.agentType, undefined, 'a top-level session has no subagent type');
    assert.equal(core.subagentTypeOfTitle(42), null);
    assert.equal(core.subagentTypeOfTitle(`${'x'.repeat(4096)} (@a subagent)`), null, 'an over-long title is not read');

    const after = (tool, exit) => core.pluginEvent('opencode', { hookKey: 'tool.execute.after', input: { tool, sessionID: 'ses_1', callID: 'c' }, output: { output: 'FAIL\nmore', metadata: { exit } } }, 'tool.execute.after');
    assert.equal(after('bash', 2).event.kind, 'tool.failed');
    assert.equal(after('bash', 0).event.kind, 'tool.finished');
    assert.equal(after('bash', 1.5).event.kind, 'tool.finished');
    assert.equal(after('read', 2).event.kind, 'tool.finished');
  });

  test(`${name}: plugin responses: chat.message system lines, compaction context, bad input renders nothing`, () => {
    const message = core.pluginEvent('opencode', { hookKey: 'chat.message', input: { sessionID: 'ses_1' }, output: { parts: [] } }, 'chat.message').event;
    assert.deepEqual(JSON.parse(core.pluginResponse(message, { kind: 'context', text: ' run tests ' })), { system: ['run tests'] });
    assert.equal(core.pluginResponse(message, { kind: 'observe' }), '');
    assert.equal(core.pluginResponse(null, { kind: 'context', text: 'x' }), '');

    assert.deepEqual(core.systemLinesOf(''), []);
    assert.deepEqual(core.systemLinesOf('not json'), []);
    assert.deepEqual(core.systemLinesOf('{"context":["x"]}'), []);
    const long = 'y'.repeat(core.CONTEXT_CAP + 5);
    const lines = core.systemLinesOf(JSON.stringify({ system: ['a', ' ', 7, long, 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }));
    assert.deepEqual(lines, ['a', 'y'.repeat(core.CONTEXT_CAP), 'b', 'c', 'd', 'e'], 'at most 8 entries read, blank and non-text skipped, long cut');

    const output = { context: [] };
    assert.equal(core.applyPluginResponse(output, JSON.stringify({ context: ['k', '', long] })), true);
    assert.deepEqual(output.context, ['k', 'y'.repeat(core.CONTEXT_CAP)]);
    assert.equal(core.applyPluginResponse(output, 'not json'), false);
    assert.equal(core.applyPluginResponse({ context: 'x' }, '{"context":["a"]}'), false);
    assert.equal(core.applyPluginResponse({ context: [] }, '{"context":[" "]}'), false);
  });

  test(`${name}: plugin hooks: system text per top-level turn, children observed only, bounded memory, hostile input never throws`, async () => {
    const { sent, hooks } = recorder(core, (native) => JSON.stringify({ system: [`for ${native.input.sessionID}`] }));
    await hooks['chat.message']({ sessionID: 'ses_top' }, { message: {}, parts: [{ type: 'text', text: 'go' }] });
    const system = { system: ['vendor', 'for ses_top'] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top' }, system);
    assert.deepEqual(system.system, ['vendor', 'for ses_top'], 'a line already there is not added twice');
    const pushed = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top' }, pushed);
    assert.deepEqual(pushed.system, ['for ses_top']);
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top' }, { system: 'text' });
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top' }, null);
    await hooks['experimental.chat.system.transform'](null, pushed);
    await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_top' } } } });
    const cleared = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top' }, cleared);
    assert.deepEqual(cleared.system, [], 'a deleted session shows nothing');

    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_top', title: 't (@explore subagent)' } } } });
    await hooks['chat.message']({ sessionID: 'ses_child' }, { message: {}, parts: [] });
    assert.equal(sent.at(-1).wait, false, 'a child message never waits');
    assert.equal(sent.at(-1).native.parentSessionID, 'ses_top');
    await hooks['chat.message']({}, { message: {}, parts: [] });

    // Both maps keep at most PARENT_MEMORY sessions; the oldest goes first.
    for (let i = 0; i <= core.PARENT_MEMORY; i += 1) {
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: `ses_c${i}`, parentID: 'ses_top' } } } });
      await hooks['chat.message']({ sessionID: `ses_t${i}` }, { message: {}, parts: [] });
    }
    await hooks['tool.execute.before']({ tool: 'read', sessionID: 'ses_c0', callID: 'c' }, { args: {} });
    assert.equal(sent.at(-1).native.parentSessionID, undefined, 'the oldest child link was dropped');
    await hooks['tool.execute.before']({ tool: 'read', sessionID: `ses_c${core.PARENT_MEMORY}`, callID: 'c' }, { args: {} });
    assert.equal(sent.at(-1).native.parentSessionID, 'ses_top');
    const oldest = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_t0' }, oldest);
    assert.deepEqual(oldest.system, [], 'the oldest turn text was dropped');
    const newest = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID: `ses_t${core.PARENT_MEMORY}` }, newest);
    assert.deepEqual(newest.system, [`for ses_t${core.PARENT_MEMORY}`]);

    const count = sent.length;
    await hooks.event(throwing('event'));
    await hooks['chat.message'](throwing('sessionID'), { parts: [] });
    await hooks['experimental.chat.system.transform'](throwing('sessionID'), { system: [] });
    assert.equal(sent.length, count, 'hostile input is dropped, never forwarded');
  });
}
