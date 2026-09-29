// HCF-01, HKR-02: the shared adapter core (src/common.ts, byte-identical in all five
// packages) behaves the same from every package's own build. Each package's dist/common.js
// is exercised directly, so every copy is covered, not only the one a harness happens to use.
// No real harness runs here; the forwarder test spawns this node with a temp launcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const PACKAGES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const cores = await Promise.all(PACKAGES.map(async (name) => ({ name, core: await import(pathToFileURL(join(root, name, 'dist', 'common.js')).href) })));

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

for (const { name, core } of cores) {
  test(`${name}: object and key guards`, () => {
    assert.equal(core.isPlainObject({}), true);
    assert.equal(core.isPlainObject(Object.create(null)), true);
    assert.equal(core.isPlainObject([]), false);
    assert.equal(core.isPlainObject(null), false);
    assert.equal(core.isPlainObject('x'), false);
    assert.equal(core.isPlainObject(new Date()), false);
    assert.equal(core.own({ a: 1 }, 'a'), 1);
    assert.equal(core.own(Object.create({ inherited: 1 }), 'inherited'), undefined);

    assert.equal(core.hasUnsafeKey({ a: [{ b: 1 }] }), false);
    assert.equal(core.hasUnsafeKey(JSON.parse('{"a":{"__proto__":{"x":1}}}')), true);
    assert.equal(core.hasUnsafeKey({ list: [{ constructor: 1 }] }), true);
    assert.equal(core.hasUnsafeKey({ [Symbol('s')]: 1 }), true);
    let deep = {};
    for (let i = 0; i < 70; i += 1) deep = { next: deep };
    assert.equal(core.hasUnsafeKey(deep), true, 'nesting past 64 levels is refused');
    assert.equal(core.hasUnsafeKey(7), false);
  });

  test(`${name}: byte lengths match UTF-8`, () => {
    for (const text of ['', 'abc', 'é', '€', 'emoji 😀 mixed ü', 'x'.repeat(300)]) {
      assert.equal(core.utf8Length(text), Buffer.byteLength(text, 'utf8'), text);
    }
    assert.equal(core.utf8Length('\ud800'), 3, 'a lone high surrogate at the end counts as three bytes');
    assert.equal(core.jsonLength({ a: 'é' }), Buffer.byteLength('{"a":"é"}'));
    const circular = {};
    circular.self = circular;
    assert.equal(core.jsonLength(circular), Number.POSITIVE_INFINITY);
    assert.equal(core.jsonLength(undefined), Number.POSITIVE_INFINITY);
    assert.equal(core.jsonLength(10n), Number.POSITIVE_INFINITY);
  });

  test(`${name}: scalar readers return null for anything unexpected`, () => {
    assert.equal(core.field('  ok  '), 'ok');
    assert.equal(core.field(''), null);
    assert.equal(core.field('   '), null);
    assert.equal(core.field(5), null);
    assert.equal(core.field('x'.repeat(257)), null);
    assert.equal(core.field('abc', 2), null);
    assert.equal(core.field('a\nb'), null);
    assert.equal(core.field('a\u007fb'), null);
    assert.equal(core.flag(true), true);
    assert.equal(core.flag('true'), null);
    assert.equal(core.count(3), 3);
    assert.equal(core.count(-1), null);
    assert.equal(core.count(1.5), null);
    assert.equal(core.count(2 ** 32), null);
    assert.equal(core.count('3'), null);
    assert.equal(core.sizeOf(undefined), null);
    assert.equal(core.sizeOf('é'), 2);
    assert.equal(core.sizeOf([1, 2]), 5);
    const circular = [];
    circular.push(circular);
    assert.equal(core.sizeOf(circular), null);
    assert.equal(core.keyNames('x'), null);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const names = core.keyNames({ ...many, ['y'.repeat(65)]: 1, 'bad\nkey': 1 });
    assert.equal(names.length, 32);
    assert.deepEqual(names.slice(0, 2), ['k00', 'k01']);
    assert.equal(names.some((key) => key.startsWith('y') || key.includes('\n')), false);
  });

  test(`${name}: the payload drops nulls and is trimmed under the cap`, () => {
    assert.deepEqual(core.boundedPayload({ b: 1, a: null, c: undefined, d: 'x' }), { b: 1, d: 'x' });
    const big = core.boundedPayload({ a: 'x'.repeat(3000), b: 'y'.repeat(3000), c: 1 });
    assert.ok(core.jsonLength(big) <= core.PAYLOAD_CAP);
    assert.deepEqual(Object.keys(big), ['a']);
    assert.deepEqual(core.boundedPayload({ only: 'z'.repeat(5000) }), {});
  });

  test(`${name}: the pure SHA-256 matches node:crypto`, () => {
    for (const text of ['', 'abc', 'é€😀', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000)]) {
      assert.equal(core.sha256Hex(text), sha(text), `length ${text.length}`);
    }
  });

  test(`${name}: screening and event building`, () => {
    assert.equal(core.screen([]), 'NOT_OBJECT');
    assert.equal(core.screen(JSON.parse('{"__proto__":{}}')), 'UNSAFE_KEY');
    assert.equal(core.screen({ big: 'x'.repeat(core.INPUT_CAP + 1) }), 'OVER_CAP');
    assert.equal(core.screen({ ok: 1 }), null);
    assert.deepEqual(core.refuse('MISSING_FIELD', 'Stop'), { ok: false, reasonCode: 'MISSING_FIELD', nativeEventName: 'Stop' });

    const parts = { harness: 'codex', nativeEventName: 'Stop', kind: 'turn.stopped', blocking: false, responseRequired: false, payload: {} };
    const built = core.buildEvent(parts);
    assert.equal(built.ok, true);
    assert.equal(built.event.sessionId, null);
    assert.match(built.event.dedupKey, /^[0-9a-f]{64}$/);
    assert.equal(core.buildEvent(parts).event.dedupKey, built.event.dedupKey, 'the key is deterministic');
    assert.notEqual(core.buildEvent({ ...parts, dedup: ['p1'] }).event.dedupKey, built.event.dedupKey);
    assert.notEqual(core.buildEvent({ ...parts, sessionId: 's1' }).event.dedupKey, built.event.dedupKey);
  });

  test(`${name}: context text is trimmed, bounded and only for context or explain`, () => {
    assert.equal(core.contextText({ kind: 'observe' }), null);
    assert.equal(core.contextText({ kind: 'route', model: 'claude-haiku-4-5' }), null);
    assert.equal(core.contextText({ kind: 'context', text: 5 }), null);
    assert.equal(core.contextText({ kind: 'context', text: '   ' }), null);
    assert.equal(core.contextText({ kind: 'explain', text: ' why ' }), 'why');
    assert.equal(core.contextText({ kind: 'context', text: 'x'.repeat(core.CONTEXT_CAP + 10) }).length, core.CONTEXT_CAP);
    assert.deepEqual(JSON.parse(core.hookSpecificContext('SessionStart', 'hi')), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' } });
  });

  test(`${name}: command hook fields become a summary without content`, () => {
    const spec = { kind: 'tool.proposed', blocking: true, responseRequired: true };
    const native = {
      session_id: 's1',
      turn_id: 't1',
      tool_use_id: 'u1',
      tool_name: 'Task',
      agent_id: 'a1',
      agent_type: 'general',
      model: 'm1',
      permission_mode: 'default',
      cwd: '/work',
      source: 'startup',
      trigger: 'manual',
      tool_input: { model: 'haiku', prompt: 'secret text' },
      tool_response: 'output text',
      prompt: 'prompt text',
      last_assistant_message: 'reply',
      stop_hook_active: false,
      from_model: 'a',
      to_model: 'b',
      custom_instructions: 'keep',
      effort: { level: 'high' },
      prompt_id: 'p1',
      hook_id: 'h1',
    };
    const result = core.commandHookParts('claude-code', 'PreToolUse', spec, native);
    assert.equal(result.ok, true);
    const { event } = result;
    assert.deepEqual(
      [event.sessionId, event.turnId, event.toolUseId, event.toolName, event.agentId, event.model, event.permissionMode, event.cwd, event.trigger],
      ['s1', 't1', 'u1', 'Task', 'a1', 'm1', 'default', '/work', 'startup'],
    );
    assert.equal(event.payload.requestedModel, 'haiku');
    assert.equal(event.payload.effort, 'high');
    assert.deepEqual(event.payload.toolInputKeys, ['model', 'prompt']);
    assert.equal(JSON.stringify(event).includes('secret text'), false, 'tool input values never enter the event');
    assert.equal(JSON.stringify(event).includes('prompt text'), false);

    // The subagent type is the one tool-input value that leaves the hook (C's subagent route).
    const typed = core.commandHookParts('claude-code', 'PreToolUse', spec, { ...native, tool_input: { subagent_type: 'Explore', description: 'secret description', prompt: 'prompt text' } });
    assert.equal(typed.event.payload.subagentType, 'Explore');
    assert.equal(JSON.stringify(typed.event).includes('secret description'), false);
    assert.equal(core.commandHookParts('claude-code', 'PreToolUse', spec, { ...native, tool_input: { subagent_type: 'x'.repeat(65) } }).event.payload.subagentType, undefined, 'an over-long label is dropped, not cut');
    assert.equal(event.payload.subagentType, undefined, 'no subagent_type, no field');

    const reason = core.commandHookParts('codex', 'Stop', spec, { reason: 'done', effort: 'high', tool_input: 'text' });
    assert.equal(reason.event.trigger, 'done');
    assert.equal(reason.event.payload.effort, undefined);
    assert.equal(reason.event.payload.requestedModel, undefined);
    assert.equal(core.commandHookParts('codex', 'Stop', spec, { trigger: 'auto' }).event.trigger, 'auto');
    assert.equal(core.commandHookParts('codex', 'Stop', spec, {}).event.trigger, null);
  });

  test(`${name}: plugin bus events and hook calls normalize, anything else is refused`, () => {
    assert.deepEqual(core.pluginEvent('opencode', {}, undefined), { ok: false, reasonCode: 'MISSING_FIELD', nativeEventName: null });
    assert.equal(core.pluginEvent('opencode', { event: 'x' }, 'event').reasonCode, 'MISSING_FIELD');
    assert.equal(core.pluginEvent('opencode', { event: { properties: {} } }, 'event').reasonCode, 'MISSING_FIELD');
    assert.deepEqual(core.pluginEvent('opencode', { event: { type: 'lsp.updated' } }, 'event'), { ok: false, reasonCode: 'UNKNOWN_EVENT', nativeEventName: 'lsp.updated' });

    const kinds = {
      'session.created': 'session.started',
      'session.idle': 'turn.stopped',
      'session.compacted': 'context.compacted',
      'session.deleted': 'session.ended',
      'session.error': 'turn.failed',
      'permission.asked': 'permission.asked',
      'permission.replied': 'permission.replied',
      'file.edited': 'file.edited',
      'command.executed': 'command.executed',
      'todo.updated': 'todo.updated',
    };
    for (const [type, kind] of Object.entries(kinds)) {
      const result = core.pluginEvent('kilocode', { event: { type } }, undefined);
      assert.equal(result.ok, true, type);
      assert.equal(result.event.kind, kind);
      assert.equal(result.event.sessionId, null, 'no properties means no session');
    }
    const sessions = [
      [{ sessionID: 's1' }, 's1'],
      [{ sessionId: 's2' }, 's2'],
      [{ info: { sessionID: 's3' } }, 's3'],
      [{ info: { id: 's4' } }, 's4'],
      [{ info: 'x' }, null],
    ];
    for (const [properties, expected] of sessions) {
      assert.equal(core.pluginEvent('opencode', { event: { type: 'session.idle', properties } }, 'event').event.sessionId, expected);
    }
    const permission = core.pluginEvent('opencode', { event: { type: 'permission.asked', properties: { callID: 'c1', type: 'bash', permissionID: 'p1' } } }, 'event');
    assert.deepEqual([permission.event.toolUseId, permission.event.toolName], ['c1', 'bash']);
    assert.deepEqual(permission.event.payload.propertyKeys, ['callID', 'permissionID', 'type']);

    assert.deepEqual(core.pluginEvent('opencode', { hookKey: 'shell.env', input: {} }, undefined), { ok: false, reasonCode: 'UNKNOWN_EVENT', nativeEventName: 'shell.env' });
    assert.equal(core.pluginEvent('opencode', { input: 'x' }, 'tool.execute.before').reasonCode, 'MISSING_FIELD');

    const before = core.pluginEvent(
      'opencode',
      { hookKey: 'tool.execute.before', input: { sessionID: 's', callID: 'c', tool: 'bash', agent: 'build', model: { providerID: 'p', modelID: 'm' } }, output: { args: { command: 'ls -la' } } },
      undefined,
    );
    assert.equal(before.ok, true);
    assert.deepEqual([before.event.kind, before.event.toolName, before.event.agentId, before.event.model, before.event.blocking], ['tool.proposed', 'bash', 'build', 'p/m', true]);
    assert.deepEqual(before.event.payload.argKeys, ['command']);
    assert.equal(JSON.stringify(before.event).includes('ls -la'), false);

    const chat = core.pluginEvent('kilocode', { input: { sessionID: 's', model: 'p/m', messageID: 'm1' }, output: { parts: [1, 2] } }, 'chat.message');
    assert.deepEqual([chat.event.kind, chat.event.model, chat.event.payload.partCount], ['task.requested', 'p/m', 2]);
    const partial = core.pluginEvent('kilocode', { input: { model: { modelID: 'only' } } }, 'tool.execute.after');
    assert.equal(partial.event.model, 'only');
    const compacting = core.pluginEvent('kilocode', { input: { sessionID: 's' }, output: { context: ['a'] } }, 'experimental.session.compacting');
    assert.deepEqual([compacting.event.kind, compacting.event.payload.contextCount], ['context.compacting', 1]);
  });

  test(`${name}: a slash command and a finished assistant message map to their Claude equivalents`, () => {
    const command = core.pluginEvent('kilocode', { input: { command: 'review', sessionID: 's', arguments: 'secret args' }, output: { parts: [] } }, 'command.execute.before');
    assert.deepEqual([command.event.kind, command.event.toolName, command.event.payload.argumentBytes], ['command.requested', 'review', 11]);
    assert.equal(JSON.stringify(command.event).includes('secret args'), false);
    const info = { id: 'msg_2', sessionID: 's', role: 'assistant', providerID: 'anthropic', modelID: 'm1', mode: 'build', time: { created: 1, completed: 2 }, tokens: { input: 10, output: 5, reasoning: 1 } };
    const done = core.pluginEvent('opencode', { event: { type: 'message.updated', properties: { info } } }, 'event');
    assert.equal(done.ok, true);
    assert.deepEqual([done.event.kind, done.event.model, done.event.sessionId], ['message.completed', 'anthropic/m1', 's']);
    assert.deepEqual([done.event.payload.inputTokens, done.event.payload.outputTokens, done.event.payload.reasoningTokens, done.event.payload.agent], [10, 5, 1, 'build']);
    const noTokens = core.pluginEvent('opencode', { event: { type: 'message.updated', properties: { info: { ...info, tokens: 'x', mode: undefined, agent: 'plan' } } } }, 'event');
    assert.equal(noTokens.event.payload.inputTokens, undefined);
    assert.equal(noTokens.event.payload.agent, 'plan');
    for (const partial of [{ ...info, role: 'user' }, { ...info, time: { created: 1 } }, { ...info, time: 'x' }, 'x']) {
      assert.deepEqual(core.pluginEvent('opencode', { event: { type: 'message.updated', properties: { info: partial } } }, 'event'), { ok: false, reasonCode: 'UNKNOWN_EVENT', nativeEventName: 'message.updated' });
    }
  });

  test(`${name}: plugin responses carry compaction context only`, () => {
    const compacting = core.pluginEvent('opencode', { input: { sessionID: 's' } }, 'experimental.session.compacting').event;
    const idle = core.pluginEvent('opencode', { event: { type: 'session.idle' } }, 'event').event;
    assert.equal(core.pluginResponse(null, { kind: 'context', text: 'x' }), '');
    assert.equal(core.pluginResponse(compacting, { kind: 'observe' }), '');
    assert.equal(core.pluginResponse(idle, { kind: 'context', text: 'x' }), '');
    assert.equal(core.pluginResponse(compacting, { kind: 'context', text: ' ' }), '');
    assert.equal(core.pluginResponse(compacting, { kind: 'context', text: 'keep this' }), '{"context":["keep this"]}');

    assert.equal(core.applyPluginResponse({ context: [] }, ''), false);
    assert.equal(core.applyPluginResponse('x', '{"context":["a"]}'), false);
    assert.equal(core.applyPluginResponse({ context: [] }, '{not json'), false);
    assert.equal(core.applyPluginResponse({ context: [] }, '[]'), false);
    assert.equal(core.applyPluginResponse({ context: [] }, '{"context":"a"}'), false);
    assert.equal(core.applyPluginResponse({ context: 'a' }, '{"context":["a"]}'), false);
    const output = { context: [] };
    assert.equal(core.applyPluginResponse(output, '{"context":[" ",5]}'), false);
    const lines = ['x'.repeat(core.CONTEXT_CAP + 5), ...Array.from({ length: 10 }, (_, i) => `line ${i}`)];
    assert.equal(core.applyPluginResponse(output, JSON.stringify({ context: lines })), true);
    assert.equal(output.context.length, 8, 'at most eight lines are added');
    assert.equal(output.context[0].length, core.CONTEXT_CAP);
  });

  test(`${name}: plugin hooks forward recognised events and never throw`, async () => {
    const sent = [];
    const hooks = core.createPluginHooks({
      harness: 'opencode',
      forward: async (text, wait) => {
        sent.push({ native: JSON.parse(text), wait });
        return wait ? '{"context":["from jevris"]}' : '';
      },
    });
    assert.deepEqual(Object.keys(hooks).sort(), [...core.PLUGIN_HOOK_KEYS].sort());
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
    await hooks.event({ event: { type: 'lsp.updated' } });
    await hooks.event('not an object');
    await hooks['tool.execute.before']({ sessionID: 's', tool: 'bash' }, { args: { command: 'ls' } });
    await hooks['tool.execute.after']('bad input');
    await hooks['chat.message']({ sessionID: 's' }, { parts: [] });
    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's' }, output);
    assert.deepEqual(output.context, ['from jevris']);
    await hooks['experimental.session.compacting']('bad', output);
    assert.deepEqual(
      sent.map((item) => [item.native.hookKey, item.wait]),
      [
        ['event', false],
        ['tool.execute.before', false],
        ['chat.message', true],
        ['experimental.session.compacting', true],
      ],
    );

    // Every forwarded event carries the shim's delivery stamp (instance and sequence).
    const stamps = sent.map((item) => item.native.delivery);
    assert.ok(stamps.every((stamp) => typeof stamp.instance === 'string' && Number.isSafeInteger(stamp.seq)));
    assert.equal(new Set(stamps.map((stamp) => stamp.seq)).size, stamps.length, 'each delivered event gets its own sequence');

    // An input too big to forward has its long strings cut with a marker, and is still sent.
    sent.length = 0;
    await hooks['tool.execute.before']({ sessionID: 's', tool: 'write' }, { args: { content: 'x'.repeat(core.INPUT_CAP) } });
    assert.equal(sent[0].native.hookKey, 'tool.execute.before');
    assert.deepEqual(sent[0].native.input, { sessionID: 's', tool: 'write' });
    assert.equal(sent[0].native.output.args.content, `${'x'.repeat(32_768)}${core.CUT_MARKER}`);
    assert.equal(typeof sent[0].native.delivery.seq, 'number');
    // Only when cutting cannot make it fit is it reduced to its hook key, session and stamp.
    const wide = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, 'y'.repeat(300)]));
    await hooks['tool.execute.before']({ sessionID: 's', tool: 'write' }, { args: wide });
    assert.deepEqual(sent[1].native, { hookKey: 'tool.execute.before', input: { sessionID: 's' }, delivery: sent[1].native.delivery });
    sent.splice(1, 1);
    // A bus event too big keeps its input as it is and is still bounded by the launcher.
    await hooks.event({ event: { type: 'file.edited', properties: { file: 'f', blob: 'x'.repeat(core.INPUT_CAP) } } });
    assert.equal(sent[1].native.hookKey, 'event');
    // Input that cannot be serialized is dropped.
    const circular = { sessionID: 's' };
    circular.self = circular;
    await hooks['tool.execute.before'](circular, {});
    await hooks['tool.execute.before']({ sessionID: 's', n: 1n }, {});
    assert.equal(sent.length, 2);
  });

  test(`${name}: fire-and-forget calls are capped and a failing forwarder is a no-op`, async () => {
    const pending = [];
    let calls = 0;
    const hooks = core.createPluginHooks({
      harness: 'kilocode',
      maxInFlight: 2,
      forward: () => {
        calls += 1;
        const gate = deferred();
        pending.push(gate);
        return gate.promise;
      },
    });
    for (let i = 0; i < 4; i += 1) await hooks['tool.execute.before']({ sessionID: `s${i}`, tool: 'bash' }, {});
    assert.equal(calls, 2, 'calls past the cap are dropped, not queued');
    pending[0].resolve(5);
    pending[1].reject(new Error('launcher failed'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await hooks['tool.execute.before']({ sessionID: 'again', tool: 'bash' }, {});
    assert.equal(calls, 3, 'settled calls free their slot');

    const throwing = core.createPluginHooks({
      harness: 'kilocode',
      forward: () => {
        throw new Error('sync failure');
      },
    });
    await throwing['chat.message']({ sessionID: 's' }, {});
    const output = { context: [] };
    await throwing['experimental.session.compacting']({ sessionID: 's' }, output);
    assert.deepEqual(output.context, []);
  });

  test(`${name}: compaction waits at most its timeout and ignores late or failed answers`, async () => {
    const gates = [];
    const hooks = core.createPluginHooks({
      harness: 'opencode',
      responseTimeoutMs: 20,
      forward: () => {
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
    });
    const late = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's' }, late);
    gates[0].resolve('{"context":["too late"]}');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(late.context, [], 'an answer after the timeout is ignored');

    const lateFailure = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's' }, lateFailure);
    gates[1].reject(new Error('late failure'));
    await new Promise((resolve) => setImmediate(resolve));

    const failed = { context: [] };
    const run = hooks['experimental.session.compacting']({ sessionID: 's' }, failed);
    gates[2].reject(new Error('failed'));
    await run;
    assert.deepEqual(failed.context, []);

    const odd = { context: [] };
    const oddRun = hooks['experimental.session.compacting']({ sessionID: 's' }, odd);
    gates[3].resolve({ context: ['not a string response'] });
    await oddRun;
    assert.deepEqual(odd.context, []);
  });

  test(`${name}: the spawn forwarder passes the event on stdin and returns stdout only when asked`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevris-forwarder-'));
    try {
      const launcher = join(dir, 'launcher.mjs');
      await writeFile(
        launcher,
        [
          "let input = '';",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  const harness = process.argv[process.argv.indexOf('--harness') + 1];",
          "  const big = JSON.parse(input).big === true;",
          "  process.stdout.write(big ? 'y'.repeat(200000) : JSON.stringify({ harness, echoed: JSON.parse(input) }));",
          '});',
        ].join('\n'),
      );
      const forward = core.spawnForwarder(process.execPath, launcher, 'opencode');
      const answer = JSON.parse(await forward('{"hookKey":"experimental.session.compacting"}', true));
      assert.deepEqual(answer, { harness: 'opencode', echoed: { hookKey: 'experimental.session.compacting' } });
      assert.equal(await forward('{"hookKey":"event"}', false), '', 'fire-and-forget ignores stdout');
      const capped = await forward('{"big":true}', true);
      assert.ok(capped.length >= 65_536 && capped.length < 200_000, 'stdout is capped');
      const missing = core.spawnForwarder(join(dir, 'no-such-node'), launcher, 'opencode');
      assert.equal(await missing('{}', true), '');
      assert.equal(await core.spawnForwarder('', launcher, 'opencode')('{}', true), '', 'a spawn that throws resolves empty');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
