// HCF-01: the §15.4 adapter conformance suite, run against recorded fixtures for all five
// harness adapters. Each case below names the §15.4 item it covers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const PACKAGES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const adapters = await Promise.all(PACKAGES.map(async (name) => ({ name, mod: await import(pathToFileURL(join(root, name, 'dist', 'index.js')).href) })));
const A = Object.fromEntries(adapters.map(({ mod }) => [mod.LAUNCHER_NAME, mod]));

const KIND = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31}){1,3}$/;
const OUTCOMES = [
  { kind: 'observe' },
  { kind: 'context', text: 'Jevris capsule: resume at step 3.' },
  { kind: 'explain', text: 'Jevris: this switch is outside the calibrated range.' },
  { kind: 'route', model: 'claude-haiku-4-5' },
];
const EVENT_KEYS = [
  'agentId', 'blocking', 'cwd', 'dedupKey', 'harness', 'kind', 'model', 'nativeEventName', 'payload', 'permissionMode',
  'responseRequired', 'schemaVersion', 'sessionId', 'toolName', 'toolUseId', 'trigger', 'turnId',
].sort();
/** Values that live inside fixture prompts, tool inputs and outputs. None may leak. */
const CONTENT = ['npm test', 'fix the test', 'find x', 'rm -rf', '"ok"', 'done'];

function normalizeFixture(mod, fixture) {
  return mod.normalize(fixture.native, fixture.hookKey === undefined ? {} : { hookKey: fixture.hookKey });
}

function eachEvent(fn) {
  for (const { name, mod } of adapters) {
    for (const fixture of mod.FIXTURES) {
      if (fixture.kind === null) continue;
      const result = normalizeFixture(mod, fixture);
      assert.equal(result.ok, true, `${fixture.id} normalizes`);
      fn(name, mod, fixture, result.event);
    }
  }
}

test('every adapter exports the same port (the byte-identical core is checked by lint/adapter-common.lint.mjs)', () => {
  for (const { name, mod } of adapters) {
    for (const key of ['HARNESS_ID', 'LAUNCHER_NAME', 'normalize', 'protocolResponse', 'FIXTURES']) assert.ok(key in mod, `${name}.${key}`);
    assert.ok(mod.FIXTURES.length >= 5);
  }
  assert.deepEqual(adapters.map(({ mod }) => mod.LAUNCHER_NAME), ['claude', 'codex', 'kilo', 'opencode', 'agy']);
});

test('event validation: each fixture maps to its domain kind or its refusal, and nothing else', () => {
  for (const { mod } of adapters) {
    for (const fixture of mod.FIXTURES) {
      const result = normalizeFixture(mod, fixture);
      if (fixture.kind === null) {
        assert.equal(result.ok, false, fixture.id);
        assert.equal(result.reasonCode, fixture.refusal, fixture.id);
        continue;
      }
      assert.equal(result.ok, true, fixture.id);
      const event = result.event;
      assert.equal(event.kind, fixture.kind, fixture.id);
      assert.match(event.kind, KIND);
      assert.equal(event.harness, mod.HARNESS_ID);
      assert.match(event.dedupKey, /^[0-9a-f]{64}$/);
      assert.ok(Buffer.byteLength(JSON.stringify(event.payload)) <= 4096);
    }
  }
});

test('event validation: payloads carry sizes and names, never prompt, input or output content', () => {
  eachEvent((_name, _mod, fixture, event) => {
    const text = JSON.stringify(event);
    for (const needle of CONTENT) assert.equal(text.includes(needle), false, `${fixture.id} leaks ${needle}`);
  });
});

test('event validation: oversized, polluted and non-object input is refused by every adapter', () => {
  const big = { hook_event_name: 'Stop', event: { type: 'session.idle' }, pad: 'x'.repeat(140_000) };
  const polluted = JSON.parse('{"hook_event_name":"Stop","event":{"type":"session.idle","properties":{"__proto__":{"a":1}}}}');
  for (const { mod } of adapters) {
    assert.equal(mod.normalize(big).reasonCode, 'OVER_CAP');
    assert.equal(mod.normalize(polluted).reasonCode, 'UNSAFE_KEY');
    for (const value of [null, 'Stop', 3, [], undefined]) assert.equal(mod.normalize(value).reasonCode, 'NOT_OBJECT');
  }
});

test('duplicate delivery: the same native event gives the same dedup key; a new call gives a new one', () => {
  eachEvent((name, mod, fixture, event) => {
    assert.equal(normalizeFixture(mod, fixture).event.dedupKey, event.dedupKey, fixture.id);
  });
  const { claude, codex, kilo, opencode, agy } = A;
  const pairs = [
    [claude, { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Agent', tool_use_id: 'a', tool_input: {} }, { tool_use_id: 'b' }],
    [codex, { hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', tool_name: 'Bash', tool_use_id: 'a', tool_input: {} }, { tool_use_id: 'b' }],
    [agy, { conversationId: 'c', toolCall: { name: 'run_command', args: {} }, stepIdx: 1, error: '' }, { stepIdx: 2 }],
  ];
  for (const [mod, native, change] of pairs) {
    const context = mod === agy ? { hookKey: 'PostToolUse' } : {};
    assert.notEqual(mod.normalize(native, context).event.dedupKey, mod.normalize({ ...native, ...change }, context).event.dedupKey);
  }
  for (const mod of [kilo, opencode]) {
    const call = (id) => ({ hookKey: 'tool.execute.before', input: { tool: 'bash', sessionID: 's', callID: id }, output: { args: {} } });
    assert.notEqual(mod.normalize(call('a')).event.dedupKey, mod.normalize(call('b')).event.dedupKey);
  }
  // A different harness never collides with the same identifiers.
  const bus = { event: { type: 'session.idle', properties: { sessionID: 's' } } };
  assert.notEqual(kilo.normalize(bus).event.dedupKey, opencode.normalize(bus).event.dedupKey);
});

test('stale revision: adapters never invent an event id, sequence, revision or deadline', () => {
  eachEvent((_name, _mod, fixture, event) => {
    // Only a subagent's event adds parentSessionId: the parent session, repeated from sessionId.
    if (Object.hasOwn(event, 'parentSessionId')) {
      assert.deepEqual(Object.keys(event).sort(), [...EVENT_KEYS, 'parentSessionId'].sort(), fixture.id);
      assert.equal(event.parentSessionId, event.sessionId, fixture.id);
      assert.equal(typeof event.agentId, 'string', fixture.id);
    } else {
      assert.deepEqual(Object.keys(event).sort(), EVENT_KEYS, fixture.id);
    }
    for (const key of ['eventId', 'sequence', 'expectedRevision', 'deadlineAt', 'occurredAt']) assert.equal(key in event, false);
  });
});

function assertShape(harness, event, output) {
  if (output === '') return;
  const parsed = JSON.parse(output);
  assert.equal(typeof parsed, 'object');
  assert.equal(Array.isArray(parsed), false);
  const keys = Object.keys(parsed);
  if (harness === 'kilocode' || harness === 'opencode') {
    // Compaction adds context lines; a person's message returns system text for its turn (G4).
    const key = event.nativeEventName === 'chat.message' ? 'system' : 'context';
    assert.deepEqual(keys, [key]);
    assert.ok(parsed[key].every((line) => typeof line === 'string'));
    return;
  }
  if (harness === 'antigravity') {
    if (event.nativeEventName === 'Stop') assert.deepEqual(parsed, { decision: 'stop' });
    else assert.ok(keys.every((key) => key === 'injectSteps'));
    return;
  }
  if (keys.length === 0) return;
  assert.ok(keys.length === 1 && ['hookSpecificOutput', 'systemMessage'].includes(keys[0]), `${harness} ${output}`);
  if (keys[0] === 'hookSpecificOutput') assert.equal(parsed.hookSpecificOutput.hookEventName, event.nativeEventName);
}

test('exact output shape: every event and outcome renders empty or one documented JSON object', () => {
  eachEvent((name, mod, fixture, event) => {
    for (const outcome of OUTCOMES) assertShape(mod.HARNESS_ID, event, mod.protocolResponse(event, outcome, fixture.native));
    assert.equal(mod.protocolResponse(null, { kind: 'observe' }), '');
  });
});

test('exact output shape: harnesses that require JSON get it, and nothing else does', () => {
  eachEvent((name, mod, fixture, event) => {
    const observed = mod.protocolResponse(event, { kind: 'observe' });
    if (mod.HARNESS_ID === 'codex') assert.equal(observed, ['Stop', 'SubagentStop'].includes(event.nativeEventName) ? '{}' : '', fixture.id);
    else if (mod.HARNESS_ID === 'antigravity') {
      const expected = { PreToolUse: '', Stop: '{"decision":"stop"}' }[event.nativeEventName] ?? '{}';
      assert.equal(observed, expected, fixture.id);
    } else assert.equal(observed, '', fixture.id);
  });
});

test('permission preservation: no adapter ever renders a permission, block or continue decision', () => {
  const forbidden = /permissionDecision|"behavior"|"decision":"(allow|deny|ask|force_ask|block|continue|approve)"|"continue":false|permissionOverrides|updatedPermissions/;
  eachEvent((name, mod, fixture, event) => {
    for (const outcome of OUTCOMES) {
      const output = mod.protocolResponse(event, outcome, fixture.native);
      // OD-6: Codex's routed spawn_agent is the one allowed decision (its exact shape is tested below).
      if ((fixture.id === 'codex.pre-spawn-agent' || fixture.id === 'codex.pre-spawn-agent-namespaced') && outcome.kind === 'route') continue;
      assert.equal(forbidden.test(output), false, `${fixture.id} ${outcome.kind}: ${output}`);
    }
  });
  // Antigravity PreToolUse, if it ever fires, says nothing: no decision is a native decision.
  const agy = A.agy;
  const pre = agy.normalize({ toolCall: { name: 'run_command', args: {} }, stepIdx: 1 }, { hookKey: 'PreToolUse' }).event;
  for (const outcome of OUTCOMES) assert.equal(agy.protocolResponse(pre, outcome), '');
  assert.deepEqual([...agy.REGISTERED_EVENTS].includes('PreToolUse'), false);
  assert.deepEqual([...A.codex.REGISTERED_EVENTS].includes('PermissionRequest'), false);
});

test('unsupported capability: a route or context a harness cannot take renders its no-decision form', () => {
  eachEvent((name, mod, fixture, event) => {
    const observe = mod.protocolResponse(event, { kind: 'observe' });
    // Claude's unpinned PreToolUse(Agent) is the one routable event (user pin: see adapter-claude-code tests).
    if (fixture.id === 'claude.pre-agent' || fixture.id === 'codex.pre-spawn-agent' || fixture.id === 'codex.pre-spawn-agent-namespaced') return;
    assert.equal(mod.protocolResponse(event, OUTCOMES[3], fixture.native), observe, `${fixture.id} route`);
  });
  const claude = A.claude;
  const stop = claude.normalize(claude.FIXTURES.find((fixture) => fixture.id === 'claude.stop').native).event;
  assert.equal(claude.protocolResponse(stop, OUTCOMES[1]), '', 'Claude Stop takes no context');
  const codex = A.codex;
  const compact = codex.normalize(codex.FIXTURES.find((fixture) => fixture.id === 'codex.pre-compact').native).event;
  assert.equal(codex.protocolResponse(compact, OUTCOMES[1]), '', 'Codex PreCompact takes no context');
  const kilo = A.kilo;
  const before = kilo.normalize(kilo.FIXTURES.find((fixture) => fixture.id === 'kilocode.tool-before').native).event;
  assert.equal(kilo.protocolResponse(before, OUTCOMES[1]), '', 'only compaction takes context');
  const compacting = kilo.normalize(kilo.FIXTURES.find((fixture) => fixture.id === 'kilocode.compacting').native).event;
  assert.deepEqual(JSON.parse(kilo.protocolResponse(compacting, OUTCOMES[1])), { context: [OUTCOMES[1].text] });
});

test('cancellation and offline fallback: a hung, failing or absent launcher never blocks or throws', async () => {
  for (const mod of [A.kilo, A.opencode]) {
    const hung = mod.createHooks(() => new Promise(() => {}), 50);
    const output = { context: [] };
    // The forwarder never answers, so resolving at all proves the 50 ms response timeout cut
    // it off. The 5 s race is only a hang guard (QA-05: no elapsed-time window).
    let guard;
    const settled = await Promise.race([
      hung['experimental.session.compacting']({ sessionID: 's' }, output).then(() => 'returned'),
      new Promise((resolve) => {
        guard = setTimeout(() => resolve('hung'), 5000);
      }),
    ]);
    clearTimeout(guard);
    assert.equal(settled, 'returned');
    assert.deepEqual(output.context, []);
    const failing = mod.createHooks(() => Promise.reject(new Error('down')));
    await failing['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} });
    await failing.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
    const throwing = mod.createHooks(() => {
      throw new Error('sync');
    });
    await throwing['chat.message']({ sessionID: 's' }, {});
    const absent = mod.spawnForwarder(join(root, 'missing-node'), join(root, 'missing.js'), mod.LAUNCHER_NAME);
    assert.equal(await absent('{}', true), '');
  }
  const codex = A.codex;
  const interrupt = codex.normalize(codex.FIXTURES.find((fixture) => fixture.id === 'codex.interrupt').native).event;
  assert.equal(interrupt.kind, 'turn.interrupted');
  assert.equal(codex.protocolResponse(interrupt, { kind: 'observe' }), '');
});

test('plugin hooks forward only recognised events and add only compaction context lines', async () => {
  for (const mod of [A.kilo, A.opencode]) {
    const sent = [];
    const hooks = mod.createHooks(async (json, wait) => {
      sent.push({ native: JSON.parse(json), wait });
      return wait ? JSON.stringify({ context: ['capsule line'], allow: true }) : '';
    });
    assert.deepEqual(Object.keys(hooks).sort(), [...mod.HOOK_KEYS].sort());
    assert.equal('permission.ask' in hooks, false);
    await hooks.event({ event: { type: 'message.part.updated', properties: {} } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
    const toolOutput = { args: { command: 'ls' } };
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, toolOutput);
    const output = { context: ['existing'], prompt: 'keep' };
    await hooks['experimental.session.compacting']({ sessionID: 's' }, output);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent.map((entry) => entry.native.hookKey), ['event', 'tool.execute.before', 'experimental.session.compacting']);
    assert.deepEqual(sent.map((entry) => entry.wait), [false, false, true]);
    assert.deepEqual(output, { context: ['existing', 'capsule line'], prompt: 'keep' });
    assert.deepEqual(toolOutput, { args: { command: 'ls' } });
    for (const entry of sent) assert.equal(mod.normalize(entry.native).ok, true);
  }
});

test('the pure SHA-256 matches node:crypto', () => {
  const { sha256Hex } = A.codex;
  for (const text of ['', 'abc', 'x'.repeat(1000), 'héllo 🌍', JSON.stringify({ a: [1, 2] })]) {
    assert.equal(sha256Hex(text), createHash('sha256').update(text, 'utf8').digest('hex'));
  }
});

test('OD-6: a Codex spawn_agent route is allow plus updatedInput with only model added; a pin, another tool or a bad id renders nothing', () => {
  const codex = A.codex;
  const fixture = (id) => codex.FIXTURES.find((item) => item.id === id);
  const route = { kind: 'route', model: 'gpt-6-astra' };
  const spawn = fixture('codex.pre-spawn-agent');
  const event = codex.normalize(spawn.native).event;
  assert.equal(event.payload.subagentType, 'explorer', "spawn_agent's agent_type is the subagent type");
  assert.deepEqual(JSON.parse(codex.protocolResponse(event, route, spawn.native)), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...spawn.native.tool_input, model: 'gpt-6-astra' } },
  });
  assert.equal(codex.protocolResponse(event, route), '', 'no native input (cut by the launcher): no route');
  assert.equal(codex.protocolResponse(event, { kind: 'route', model: 'bad id/x' }, spawn.native), '');
  const pinned = fixture('codex.pre-spawn-agent-pinned');
  const pinnedEvent = codex.normalize(pinned.native).event;
  assert.equal(pinnedEvent.payload.requestedModel, 'gpt-6-luna');
  assert.equal(codex.protocolResponse(pinnedEvent, route, pinned.native), '', 'a spawn that names a model is a pin');
  const effort = { ...spawn.native, tool_input: { ...spawn.native.tool_input, reasoning_effort: 'high' } };
  assert.equal(codex.protocolResponse(codex.normalize(effort).event, route, effort), '', 'a spawn that names reasoning_effort is a pin');
  const withVariant = JSON.parse(codex.protocolResponse(event, { ...route, variant: 'high' }, spawn.native));
  assert.deepEqual(Object.keys(withVariant.hookSpecificOutput.updatedInput).sort(), ['agent_type', 'message', 'model', 'task_name'], "a route's variant never adds reasoning_effort");
  const nested = { ...spawn.native, tool_input: { message: 'x', task_name: 't', items: [{ type: 'text', text: 'y' }] } };
  assert.deepEqual(JSON.parse(codex.protocolResponse(codex.normalize(nested).event, route, nested)).hookSpecificOutput.updatedInput, { ...nested.tool_input, model: 'gpt-6-astra' }, 'every key is kept with its value');
  const bash = fixture('codex.pre-tool');
  assert.equal(codex.protocolResponse(codex.normalize(bash.native).event, route, bash.native), '', 'only spawn_agent is routable');
  const bare = { ...spawn.native, tool_input: { message: 'x', task_name: 't' } };
  assert.equal(codex.normalize(bare).event.payload.subagentType, 'default', "no agent_type runs Codex's default role");
  const other = { ...spawn.native, tool_name: 'Bash' };
  assert.equal(codex.protocolResponse(event, route, other), '', 'the native input must be the spawn_agent call itself');
});

test("OD-6 (owner decision 0a9dc8c): Codex's default-namespace name collaborationspawn_agent is spawn_agent; any other namespace is not", () => {
  const codex = A.codex;
  const route = { kind: 'route', model: 'gpt-6-astra' };
  assert.deepEqual([...codex.SPAWN_HOOK_NAMES], ['spawn_agent', 'collaborationspawn_agent']);
  const namespaced = codex.FIXTURES.find((item) => item.id === 'codex.pre-spawn-agent-namespaced');
  const event = codex.normalize(namespaced.native).event;
  assert.deepEqual([event.kind, event.toolName, event.payload.subagentType], ['tool.proposed', 'spawn_agent', 'default'], 'the event reads it as spawn_agent');
  assert.deepEqual(JSON.parse(codex.protocolResponse(event, route, namespaced.native)), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...namespaced.native.tool_input, model: 'gpt-6-astra' } },
  });
  const plain = codex.FIXTURES.find((item) => item.id === 'codex.pre-spawn-agent');
  const same = { ...plain.native, tool_name: 'collaborationspawn_agent' };
  assert.equal(codex.protocolResponse(codex.normalize(same).event, route, same), codex.protocolResponse(codex.normalize(plain.native).event, route, plain.native), 'the same answer as the plain name');
  const pinned = { ...namespaced.native, tool_input: { ...namespaced.native.tool_input, model: 'gpt-6-luna' } };
  assert.equal(codex.protocolResponse(codex.normalize(pinned).event, route, pinned), '', 'a pin is still a pin');
  for (const name of ['teamspawn_agent', 'Collaborationspawn_agent', 'collaboration.spawn_agent', 'collaborationspawn_agentx', 'multi_agent_v1spawn_agent']) {
    const custom = { ...namespaced.native, tool_name: name };
    const customEvent = codex.normalize(custom).event;
    assert.equal(customEvent.toolName, name, `${name} keeps its own name`);
    assert.equal(codex.protocolResponse(customEvent, route, custom), '', `${name} is not routed`);
    assert.equal(codex.protocolResponse(event, route, custom), '', `${name} as the native input is not routed`);
  }
  const post = { ...namespaced.native, hook_event_name: 'PostToolUse', tool_response: 'ok' };
  assert.equal(codex.normalize(post).event.toolName, 'spawn_agent', 'PostToolUse reads the same name');
  assert.equal(codex.isSpawnHookName('spawn_agent'), true);
  assert.equal(codex.isSpawnHookName(null), false);
});
