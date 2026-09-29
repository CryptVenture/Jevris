// G4 (harness parity audit, approved in DOMAINS 9d6a66d; agreed with D): Kilo and OpenCode show
// Jevris text to the model. A top-level session's chat.message waits at most 300 ms for the
// launcher; the `{"system":[...]}` it renders is kept for that session and added to
// output.system by experimental.chat.system.transform on each model call of the turn, with no
// spawn. The next message, idle or delete clears it. A subagent's message waits for nothing.
import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../dist/common.js');
const kilo = await import('../dist/index.js');
const opencode = await import('@jevris/adapter-opencode');

function recorder(answer) {
  const sent = [];
  const hooks = core.createPluginHooks({
    harness: 'kilocode',
    forward: async (text, wait) => {
      const native = JSON.parse(text);
      sent.push({ native, wait });
      return wait ? answer(native) : '';
    },
  });
  return { sent, hooks };
}

test('G4: a top-level message waits, its text is added to every model call of the turn, and the turn end clears it', async () => {
  const { sent, hooks } = recorder(() => JSON.stringify({ system: ['Jevris: run the tests before you finish.'] }));
  await hooks['chat.message']({ sessionID: 'ses_top', messageID: 'm1' }, { message: {}, parts: [{ type: 'text', text: 'fix it' }] });
  assert.deepEqual(sent.map((item) => [item.native.hookKey, item.wait]), [['chat.message', true]]);
  for (let step = 0; step < 3; step += 1) {
    const output = { system: ['vendor prompt'] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top', model: { id: 'm' } }, output);
    assert.deepEqual(output.system, ['vendor prompt', 'Jevris: run the tests before you finish.'], 'each step of the turn');
  }
  assert.equal(sent.length, 1, 'the transform never spawns the launcher');
  const other = { system: [] };
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_other', model: {} }, other);
  assert.deepEqual(other.system, [], 'only the session that asked');
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_top' } } });
  const after = { system: [] };
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top', model: {} }, after);
  assert.deepEqual(after.system, [], 'idle ends the turn and its text');
});

test('G4: a subagent message is observed only; a new message replaces the text; bad input never throws', async () => {
  let answer = JSON.stringify({ system: ['first'] });
  const { sent, hooks } = recorder(() => answer);
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_top' } } } });
  await hooks['chat.message']({ sessionID: 'ses_child' }, { message: {}, parts: [] });
  assert.equal(sent.at(-1).wait, false, 'a child session never waits');
  const child = { system: [] };
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_child', model: {} }, child);
  assert.deepEqual(child.system, []);

  await hooks['chat.message']({ sessionID: 'ses_top' }, { message: {}, parts: [] });
  answer = '';
  await hooks['chat.message']({ sessionID: 'ses_top' }, { message: {}, parts: [] });
  const output = { system: [] };
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top', model: {} }, output);
  assert.deepEqual(output.system, [], 'a new message with nothing to show clears the old text');

  await hooks['experimental.chat.system.transform']('bad', { system: [] });
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top' }, { system: 'not a list' });
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top' }, null);
  await hooks['chat.message']('bad', null);
});

test('G4: a slow launcher costs the message at most the deadline, adds nothing and is counted', async () => {
  const sent = [];
  const hooks = core.createPluginHooks({
    harness: 'opencode',
    messageTimeoutMs: 30,
    forward: async (text, wait) => {
      sent.push({ native: JSON.parse(text), wait });
      // A launcher that never answers: the message still goes on, so the wait is only the deadline.
      return wait ? new Promise(() => {}) : '';
    },
  });
  await hooks['chat.message']({ sessionID: 'ses_top' }, { message: {}, parts: [] });
  const output = { system: [] };
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top', model: {} }, output);
  assert.deepEqual(output.system, []);
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_top' } } });
  assert.deepEqual(sent.at(-1).native.shimMisses, [{ reasonCode: 'SHIM_TIMEOUT', count: 1, maxMs: 30 }]);
  assert.equal(core.MESSAGE_TIMEOUT_MS, 300);
});

for (const [name, adapter] of [['kilocode', kilo], ['opencode', opencode]]) {
  test(`G4 ${name}: chat.message renders context or an explanation as system text; compaction still renders context only`, () => {
    const message = adapter.normalize({ hookKey: 'chat.message', input: { sessionID: 's', messageID: 'm' }, output: { message: {}, parts: [{ type: 'text', text: 'hi' }] } }, { hookKey: 'chat.message' });
    assert.equal(message.ok, true);
    assert.equal(adapter.protocolResponse(message.event, { kind: 'context', text: 'ctx' }), JSON.stringify({ system: ['ctx'] }));
    assert.equal(adapter.protocolResponse(message.event, { kind: 'explain', text: 'why' }), JSON.stringify({ system: ['why'] }));
    assert.equal(adapter.protocolResponse(message.event, { kind: 'observe' }), '');
    const compacting = adapter.normalize({ hookKey: 'experimental.session.compacting', input: { sessionID: 's' }, output: { context: [] } }, { hookKey: 'experimental.session.compacting' });
    assert.equal(adapter.protocolResponse(compacting.event, { kind: 'explain', text: 'why' }), '');
    assert.deepEqual(core.systemLinesOf(JSON.stringify({ system: ['a', 7, '', 'b'] })), ['a', 'b']);
    assert.deepEqual(core.systemLinesOf('not json'), []);
  });
}
