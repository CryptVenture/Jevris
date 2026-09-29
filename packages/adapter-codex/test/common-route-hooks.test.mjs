// R20 and OD-8 in the Kilo and OpenCode shim hooks (createPluginHooks), from every package's own
// build of the shared core. A stand-in forwarder plays the launcher; no harness runs and no
// launcher is spawned. Every write is a model and nothing else, and any doubt writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const PACKAGES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const cores = await Promise.all(PACKAGES.map(async (name) => ({ name, core: await import(join(root, name, 'dist', 'common.js')) })));

const OPUS = { providerID: 'anthropic', modelID: 'claude-opus-5-5' };
const HAIKU_ROUTE = { providerID: 'anthropic', modelID: 'claude-haiku-4-5', variant: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function switchPayload(harness) {
  return {
    harness,
    mainSession: { mode: 'plugin-bounded-auto', switched: true },
    outcome: 'switch',
    actuate: true,
    reasonCode: 'PROMOTED_SAVING',
    text: 'Jevris: this turn runs on a cheaper model.',
    model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
  };
}

/**
 * A shim with a stand-in launcher. `answer(native)` is what the launcher prints for an awaited
 * call; `config` is the project config check (default: allowed; null: none).
 */
function shim(core, harness, answer, config = async () => true) {
  const sent = [];
  const hooks = core.createPluginHooks({
    harness,
    forward: async (text, wait) => {
      const native = JSON.parse(text);
      sent.push({ native, wait });
      return wait ? answer(native) : '';
    },
    ...(config === null ? {} : { projectConfig: config }),
  });
  return { sent, hooks };
}

const created = (id, parentID, title) => ({ event: { type: 'session.created', properties: { info: { id, ...(parentID === undefined ? {} : { parentID }), ...(title === undefined ? {} : { title }) } } } });
const taskInput = (session, callID = 'call_1') => ({ tool: 'task', sessionID: session, callID });
const taskOutput = (extra = {}) => ({ args: { description: 'look', prompt: 'find x', subagent_type: 'explore', ...extra } });
const turnInput = (session, messageID, model = OPUS, extra = {}) => ({ sessionID: session, messageID, agent: 'build', model, ...extra });
// The harness's resolved message (R53): the model the turn runs on, even when the input names none.
const turnOutput = (model = OPUS, id = 'm') => ({ message: { id, model: { ...model } }, parts: [{ type: 'text', text: 'go' }] });
const LUNA = { providerID: 'openai', modelID: 'gpt-6-luna' };

for (const { name, core } of cores) {
  test(`${name}: a task call never has its arguments changed; only an unpinned call in a known session waits for a route`, async () => {
    for (const harness of ['kilocode', 'opencode']) {
      const { sent, hooks } = shim(core, harness, (native) => (native.hookKey === 'tool.execute.before' ? JSON.stringify({ route: { ...HAIKU_ROUTE, variant: 'low' } }) : ''));
      await hooks.event(created('ses_top'));
      const output = taskOutput();
      await hooks['tool.execute.before'](taskInput('ses_top'), output);
      assert.deepEqual(output.args, taskOutput().args, `${harness}: the task tool applies no model argument, so none is written`);
      assert.equal(sent.at(-1).wait, true, 'the task call waits for its route');

      const pinned = taskOutput({ model: 'claude-sonnet-4-5' });
      await hooks['tool.execute.before'](taskInput('ses_top', 'call_2'), pinned);
      assert.equal(pinned.args.model, 'claude-sonnet-4-5');
      assert.equal(sent.at(-1).wait, false, 'a pinned call is only observed');

      await hooks['tool.execute.before'](taskInput('ses_never_seen', 'call_3'), taskOutput());
      assert.equal(sent.at(-1).wait, false, 'a session the shim did not see start is never routed');

      const bash = { args: { command: 'ls' } };
      await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_top', callID: 'call_4' }, bash);
      assert.deepEqual(bash.args, { command: 'ls' });

      const getter = { tool: 'task' };
      Object.defineProperty(getter, 'sessionID', { enumerable: true, get() { throw new Error('hostile'); } });
      await hooks['tool.execute.before'](getter, taskOutput());
      await hooks['tool.execute.before'](taskInput('ses_top', 'call_5'), null);
    }
  });

  test(`${name}: Kilo and OpenCode hold a task route for the one child it starts, on its parent's turn model and agent`, async () => {
    const ROUTED = { providerID: 'anthropic', modelID: 'claude-haiku-4-5' };
    const play = async (harness, { childModel = OPUS, agent = 'explore', title = 'look (@explore subagent)', calls = 1, release = false, config, answer = JSON.stringify({ route: HAIKU_ROUTE }) } = {}) => {
      const { hooks } = shim(core, harness, (native) => (native.hookKey === 'tool.execute.before' ? answer : ''), config);
      await hooks.event(created('ses_top'));
      await hooks['chat.message'](turnInput('ses_top', 'msg_1'), turnOutput());
      for (let i = 1; i <= calls; i += 1) await hooks['tool.execute.before'](taskInput('ses_top', `call_${i}`), taskOutput());
      if (release) await hooks['tool.execute.after'](taskInput('ses_top', 'call_1'), { output: 'done' });
      await hooks.event(created('ses_child', 'ses_top', title));
      const output = turnOutput(childModel);
      await hooks['chat.message']({ sessionID: 'ses_child', agent, model: childModel }, output);
      const again = turnOutput(childModel);
      await hooks['chat.message']({ sessionID: 'ses_child', agent, model: childModel }, again);
      return { first: output.message.model, second: again.message.model };
    };
    for (const harness of ['kilocode', 'opencode']) {
      const routed = await play(harness);
      assert.deepEqual(routed.first, ROUTED, `${harness}: the child's first message runs on the route`);
      assert.deepEqual(routed.second, OPUS, 'only the first message: the child keeps what the harness stored for it');
      assert.deepEqual((await play(harness, { answer: JSON.stringify({ route: { ...HAIKU_ROUTE, variant: 'low' } }) })).first, { ...ROUTED, variant: 'low' }, 'a variant goes with the model');
      for (const [label, options] of [
        ['an agent with its own model (a pin)', { childModel: LUNA }],
        ['another agent than the task asked for', { agent: 'general' }],
        ['a title naming another agent', { title: 'look (@general subagent)' }],
        ['two task calls in flight', { calls: 2 }],
        ['the call already finished', { release: true }],
        ['the project redefines the provider', { config: async () => false }],
        ['the check throws', { config: () => { throw new Error('x'); } }],
        ['the check rejects', { config: async () => { throw new Error('x'); } }],
        ['the check is late', { config: () => sleep(core.PROJECT_CONFIG_TIMEOUT_MS + 100).then(() => true) }],
        ['no check at all', { config: null }],
        ['no answer', { answer: '' }],
        ['an answer that is not JSON', { answer: 'not json' }],
        ['an answer with another field', { answer: JSON.stringify({ route: { ...HAIKU_ROUTE, baseURL: 'http://x' } }) }],
        ['an answer with text beside it', { answer: JSON.stringify({ route: HAIKU_ROUTE, system: ['x'] }) }],
      ]) {
        const { first } = await play(harness, options);
        assert.deepEqual(first, options.childModel ?? OPUS, `${harness}: ${label}`);
      }
    }
    // Two calls, one finished: the second is still ambiguous, so nothing is written.
    const { hooks } = shim(core, 'kilocode', () => JSON.stringify({ route: HAIKU_ROUTE }));
    await hooks.event(created('ses_top'));
    await hooks['chat.message'](turnInput('ses_top', 'msg_1'), turnOutput());
    await hooks['tool.execute.before'](taskInput('ses_top', 'call_1'), taskOutput());
    await hooks['tool.execute.before'](taskInput('ses_top', 'call_2'), taskOutput());
    await hooks['tool.execute.after'](taskInput('ses_top', 'call_1'), {});
    await hooks['tool.execute.after'](taskInput('ses_top', 'call_9'), {});
    await hooks['tool.execute.after']({ tool: 'task', sessionID: 'ses_none', callID: 'c' }, {});
    await hooks.event(created('ses_child', 'ses_top'));
    const output = turnOutput();
    await hooks['chat.message']({ sessionID: 'ses_child', agent: 'explore', model: OPUS }, output);
    assert.deepEqual(output.message.model, OPUS);
  });

  test(`${name}: a top-level turn asks route.turn from its second turn, writes only an actuating answer for its own ids, and never after the person changes model`, async () => {
    for (const harness of ['kilocode', 'opencode']) {
      let payload = switchPayload(harness);
      let ids = (native) => ({ sessionId: native.input.sessionID, messageId: native.input.messageID ?? null });
      const { sent, hooks } = shim(core, harness, (native) => (native.hookKey === 'chat.message' && native.routeTurn === true ? JSON.stringify({ system: ['Jevris: switched.'], turn: { ...ids(native), payload } }) : ''));
      await hooks.event(created('ses_top'));
      const first = turnOutput();
      await hooks['chat.message'](turnInput('ses_top', 'msg_1'), first);
      assert.equal(sent.at(-1).native.routeTurn, undefined, 'the first turn seen asks nothing');
      assert.deepEqual(first.message.model, OPUS);

      const second = turnOutput();
      await hooks['chat.message'](turnInput('ses_top', 'msg_2'), second);
      assert.equal(sent.at(-1).native.routeTurn, true);
      assert.deepEqual(second.message.model, { providerID: 'anthropic', modelID: 'claude-haiku-4-5' }, `${harness}: the turn runs on the switch`);
      const system = { system: [] };
      await hooks['experimental.chat.system.transform']({ sessionID: 'ses_top' }, system);
      assert.deepEqual(system.system, ['Jevris: switched.'], 'the answer text still shows');

      ids = () => ({ sessionId: 'ses_top', messageId: 'msg_other' });
      const wrongIds = turnOutput();
      await hooks['chat.message'](turnInput('ses_top', 'msg_3'), wrongIds);
      assert.deepEqual(wrongIds.message.model, OPUS, 'an answer for another message writes nothing');

      ids = (native) => ({ sessionId: native.input.sessionID, messageId: native.input.messageID ?? null });
      payload = { ...switchPayload(harness), mainSession: { mode: 'advice-only', switched: false }, actuate: false };
      const advice = turnOutput();
      await hooks['chat.message'](turnInput('ses_top', 'msg_4'), advice);
      assert.deepEqual(advice.message.model, OPUS, 'advice never switches');

      payload = switchPayload(harness);
      const changed = turnOutput(LUNA);
      await hooks['chat.message'](turnInput('ses_top', 'msg_5', LUNA), changed);
      assert.equal(sent.at(-1).native.routeTurn, undefined, 'the person changed the model: not asked');
      assert.deepEqual(changed.message.model, LUNA);
      const back = turnOutput();
      await hooks['chat.message'](turnInput('ses_top', 'msg_6'), back);
      assert.equal(sent.at(-1).native.routeTurn, undefined, 'and never again in this session');
      assert.deepEqual(back.message.model, OPUS);

      // A variant change is the person's choice too; a session the shim did not see start is never asked.
      const other = shim(core, harness, () => JSON.stringify({ turn: { sessionId: 'ses_b', messageId: 'b2', payload: switchPayload(harness) } }));
      await other.hooks.event(created('ses_b'));
      await other.hooks['chat.message'](turnInput('ses_b', 'b1'), turnOutput());
      await other.hooks['chat.message'](turnInput('ses_b', 'b2', OPUS, { variant: 'high' }), turnOutput({ ...OPUS, variant: 'high' }));
      assert.equal(other.sent.at(-1).native.routeTurn, undefined);
      await other.hooks['chat.message'](turnInput('ses_unknown', 'u1'), turnOutput());
      await other.hooks['chat.message'](turnInput('ses_unknown', 'u2'), turnOutput());
      assert.equal(other.sent.at(-1).native.routeTurn, undefined, 'no session.created, no route');
      await other.hooks.event(created('ses_c'));
      await other.hooks['chat.message']({ sessionID: 'ses_c', messageID: 'c1' }, { message: { id: 'c1' }, parts: [] });
      await other.hooks['chat.message']({ sessionID: 'ses_c', messageID: 'c2' }, { message: { id: 'c2' }, parts: [] });
      assert.equal(other.sent.at(-1).native.routeTurn, undefined, 'a turn whose resolved message names no model is not asked');

      // R53: a turn that names no model of its own still has the one the harness resolved, and the
      // resolved message's id stands in for a missing messageID.
      const plain = shim(core, harness, (native) => (native.routeTurn === true ? JSON.stringify({ turn: { sessionId: 'ses_d', messageId: 'resolved_2', payload: switchPayload(harness) } }) : ''));
      await plain.hooks.event(created('ses_d'));
      await plain.hooks['chat.message']({ sessionID: 'ses_d', agent: 'build' }, turnOutput(OPUS, 'resolved_1'));
      const unnamed = turnOutput(OPUS, 'resolved_2');
      await plain.hooks['chat.message']({ sessionID: 'ses_d', agent: 'build' }, unnamed);
      assert.equal(plain.sent.at(-1).native.routeTurn, true, 'asked on the resolved model');
      assert.deepEqual(unnamed.message.model, { providerID: 'anthropic', modelID: 'claude-haiku-4-5' }, 'and switched');
      await plain.hooks['chat.message']({ sessionID: 'ses_d', agent: 'build', model: OPUS }, turnOutput(LUNA, 'resolved_3'));
      assert.equal(plain.sent.at(-1).native.routeTurn, undefined, 'a resolved model the input did not name still counts as the person changing it');
    }
  });

  test(`${name}: a turn switch needs the project config, and a deleted session forgets everything`, async () => {
    const answer = (native) => JSON.stringify({ turn: { sessionId: native.input.sessionID, messageId: native.input.messageID, payload: switchPayload('opencode') } });
    const denied = shim(core, 'opencode', answer, async () => false);
    await denied.hooks.event(created('ses_top'));
    await denied.hooks['chat.message'](turnInput('ses_top', 'msg_1'), turnOutput());
    const out = turnOutput();
    await denied.hooks['chat.message'](turnInput('ses_top', 'msg_2'), out);
    assert.deepEqual(out.message.model, OPUS, 'the project redefines the provider: nothing is written');

    const { sent, hooks } = shim(core, 'opencode', answer);
    await hooks.event(created('ses_top'));
    await hooks['chat.message'](turnInput('ses_top', 'msg_1'), turnOutput());
    await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_top' } } } });
    await hooks['chat.message'](turnInput('ses_top', 'msg_2'), turnOutput());
    assert.equal(sent.at(-1).native.routeTurn, undefined, 'a deleted session starts over');

    // The route maps are bounded like the parent map.
    const many = shim(core, 'opencode', () => '');
    for (let i = 0; i <= core.PARENT_MEMORY; i += 1) {
      await many.hooks.event(created(`ses_${i}`));
      await many.hooks['chat.message'](turnInput(`ses_${i}`, 'm1'), turnOutput());
    }
    await many.hooks['chat.message'](turnInput('ses_0', 'm2'), turnOutput());
    assert.equal(many.sent.at(-1).native.routeTurn, undefined, 'the oldest session was forgotten');
    await many.hooks['chat.message'](turnInput(`ses_${core.PARENT_MEMORY}`, 'm2'), turnOutput());
    assert.equal(many.sent.at(-1).native.routeTurn, true);

    // One record per session (B's review, LOW 14): other sessions' turns never evict a person's
    // model change while the session itself is still known.
    const kept = shim(core, 'opencode', () => '');
    await kept.hooks.event(created('ses_mine'));
    await kept.hooks['chat.message'](turnInput('ses_mine', 'm1'), turnOutput());
    await kept.hooks['chat.message'](turnInput('ses_mine', 'm2', LUNA), turnOutput(LUNA));
    for (let i = 0; i <= core.PARENT_MEMORY; i += 1) {
      await kept.hooks['chat.message'](turnInput(`ses_other_${i}`, 'm1'), turnOutput());
      await kept.hooks['chat.message'](turnInput(`ses_other_${i}`, 'm2', LUNA), turnOutput(LUNA));
    }
    await kept.hooks['chat.message'](turnInput('ses_mine', 'm3', LUNA), turnOutput(LUNA));
    assert.equal(kept.sent.at(-1).native.routeTurn, undefined, 'still changed: never asked again');
    for (let i = 0; i <= core.PARENT_MEMORY; i += 1) await kept.hooks.event(created(`ses_new_${i}`));
    await kept.hooks['chat.message'](turnInput('ses_mine', 'm4', LUNA), turnOutput(LUNA));
    assert.equal(kept.sent.at(-1).native.routeTurn, undefined, 'an evicted session has no record, so it is never asked');
    await kept.hooks['chat.message'](turnInput(`ses_new_${core.PARENT_MEMORY}`, 'm1'), turnOutput());
    await kept.hooks['chat.message'](turnInput(`ses_new_${core.PARENT_MEMORY}`, 'm2'), turnOutput());
    assert.equal(kept.sent.at(-1).native.routeTurn, true, 'a known session with no change asks from its second turn');
  });
}
