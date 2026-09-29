// Kilo and OpenCode routes through the launcher (R20, OD-8; B's review, LOW 12). A task route
// renders `{"route":...}` from the shim's own native input. A top-level turn the shim flags with
// `routeTurn` also asks route.turn, next to its event and inside the same deadline; only an answer
// that passes RouteTurnPayloadContract is added, as `{"turn":{sessionId, messageId, payload}}`.
import test from 'node:test';
import assert from 'node:assert/strict';

const { runLauncher, routeTurnBody } = await import('../dist/launcher.js');
const kilo = await import('@jevris/adapter-kilocode');
const opencode = await import('@jevris/adapter-opencode');
const claude = await import('@jevris/adapter-claude-code');
const ADAPTERS = { kilo, opencode, claude };

const OPUS = { providerID: 'anthropic', modelID: 'claude-opus-5-5' };

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

/** A stand-in sidecar: `event` answers with `decision`, `route.turn` with `turn` (a RequestResult or a function of the request). */
function sidecar({ decision = null, turn = null } = {}) {
  const requests = [];
  return {
    requests,
    sidecar: {
      async ensure() {
        return { ok: true, endpoint: 'fake', started: false };
      },
      async request(input) {
        requests.push(input);
        if (input.op === 'route.turn') {
          const answer = typeof turn === 'function' ? await turn(input) : turn;
          return answer ?? { ok: false, reason: 'unavailable', message: 'no route.turn' };
        }
        return { ok: true, result: { recorded: true, duplicate: false, results: decision === null ? {} : { decision } } };
      },
    },
  };
}

const deps = (fake) => ({ adapters: ADAPTERS, sidecar: fake, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/work', nowMs: () => Date.now() });
const run = async (harness, native, options) => {
  const fake = sidecar(options);
  const result = await runLauncher({ harness, event: null }, JSON.stringify(native), deps(fake.sidecar), Date.now());
  return { ...result, requests: fake.requests };
};

// `message` is the harness's resolved message (R53): route.turn reads its model, not input.model.
const turnNative = (extra = {}, input = {}, message = { id: 'msg_2', model: OPUS }) => ({
  hookKey: 'chat.message',
  input: { sessionID: 'ses_top', messageID: 'msg_2', agent: 'build', model: OPUS, ...input },
  output: { message, parts: [{ type: 'text', text: 'fix the test' }] },
  delivery: { instance: 'i1', seq: 4 },
  routeTurn: true,
  ...extra,
});

test('a certified Kilo or OpenCode task route renders {"route"} from the shim input; a pinned call renders nothing', async () => {
  for (const [harness, adapter, variant] of [['kilo', kilo, 'low'], ['opencode', opencode, undefined]]) {
    const id = `${adapter.HARNESS_ID}.task-before`;
    const native = adapter.FIXTURES.find((fixture) => fixture.id === id).native;
    const route = { kind: 'route', model: 'anthropic/claude-haiku-4-5', ...(variant === undefined ? {} : { variant }) };
    const routed = await run(harness, native, { decision: { hookOutcome: route, certified: true } });
    assert.equal(routed.exitCode, 0);
    assert.deepEqual(JSON.parse(routed.stdout), { route: { providerID: 'anthropic', modelID: 'claude-haiku-4-5', variant: variant ?? null } });
    const sent = JSON.stringify(routed.requests[0].body);
    assert.equal(sent.includes('find x'), false, "the task's prompt never reaches the sidecar");
    const pinned = await run(harness, adapter.FIXTURES.find((fixture) => fixture.id === `${id}-pinned`).native, { decision: { hookOutcome: route, certified: true } });
    assert.equal(pinned.stdout, '');
    const uncertified = await run(harness, native, { decision: { hookOutcome: route, certified: false } });
    assert.equal(uncertified.stdout, '');
    assert.equal(routed.requests.some((item) => item.op === 'route.turn'), false, 'a task call never asks route.turn');
  }
});

test('a flagged top-level turn asks route.turn with its own ids and model, and gets the checked answer next to its text', async () => {
  for (const [harness, wire] of [['kilo', 'kilocode'], ['opencode', 'opencode']]) {
    const result = await run(harness, turnNative(), {
      decision: { hookOutcome: { kind: 'context', text: 'Jevris: run the tests first.' }, certified: true },
      turn: { ok: true, result: switchPayload(wire) },
    });
    assert.equal(result.exitCode, 0);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(out.system, ['Jevris: run the tests first.']);
    assert.deepEqual(out.turn, { sessionId: 'ses_top', messageId: 'msg_2', payload: switchPayload(wire) });
    const asked = result.requests.find((item) => item.op === 'route.turn');
    assert.deepEqual(asked.body, { harness: wire, sessionId: 'ses_top', messageId: 'msg_2', current: OPUS, modelPin: null });
    assert.deepEqual([asked.scope, asked.budget], ['hook', 'hot']);
    const event = result.requests.find((item) => item.op === 'event');
    assert.equal(JSON.stringify(event.body).includes('routeTurn'), false, 'the flag is taken off before the adapter reads the event');
    assert.equal(JSON.stringify(asked.body).includes('fix the test'), false, "route.turn never carries the person's message text");

    const alone = await run(harness, turnNative(), { turn: { ok: true, result: switchPayload(wire) } });
    assert.deepEqual(Object.keys(JSON.parse(alone.stdout)), ['turn'], 'a turn with no text still carries its answer');
    const variant = await run(harness, turnNative({}, { variant: 'high' }, { id: 'msg_2', model: { ...OPUS, variant: 'high' } }), { turn: { ok: true, result: switchPayload(wire) } });
    assert.deepEqual(variant.requests.find((item) => item.op === 'route.turn').body.current, { ...OPUS, variant: 'high' });
  }
});

test('route.turn is asked only for a flagged, well-formed top-level turn, and a bad or failed answer adds nothing', async () => {
  const good = { ok: true, result: switchPayload('opencode') };
  const asks = async (native, harness = 'opencode') => (await run(harness, native, { turn: good })).requests.some((item) => item.op === 'route.turn');
  assert.equal(await asks(turnNative({ routeTurn: undefined })), false, 'no flag, no question');
  assert.equal(await asks(turnNative({ routeTurn: 'yes' })), false);
  assert.equal(await asks(turnNative({ parentSessionID: 'ses_parent' })), false, "a subagent's message");
  assert.equal(await asks(turnNative({}, {}, { id: 'msg_2' })), false, 'the resolved message names no model');
  assert.equal(await asks(turnNative({}, { model: undefined })), true, 'R53: a turn that names no model still has the resolved one');
  assert.equal(await asks(turnNative({}, {}, { id: 'msg_2', model: { providerID: 'Anthropic', modelID: 'x' } })), false);
  assert.equal(await asks(turnNative({}, { sessionID: 'bad id' })), false);
  assert.equal(await asks(turnNative({}, { messageID: 'bad id' })), false);
  assert.equal(await asks(turnNative({}, {}, { id: 'msg_2', model: { ...OPUS, variant: 'High' } })), false);
  assert.equal(await asks({ hookKey: 'tool.execute.before', input: { tool: 'bash', sessionID: 'ses_top', callID: 'c' }, output: { args: {} }, routeTurn: true }), false, 'only chat.message');
  assert.equal(await asks(claude.FIXTURES.find((fixture) => fixture.native?.hook_event_name === 'UserPromptSubmit').native, 'claude'), false, 'Kilo and OpenCode only');

  const invalid = { ...switchPayload('opencode'), mainSession: { mode: 'advice-only', switched: true } };
  for (const [label, turn] of [
    ['an answer the contract refuses', { ok: true, result: invalid }],
    ['a failed request', { ok: false, reason: 'error', reasonCode: 'SIDECAR_ERROR', message: 'x' }],
    ['a request that throws', () => { throw new Error('x'); }],
  ]) {
    const result = await run('opencode', turnNative(), { turn });
    assert.equal(result.exitCode, 0, label);
    assert.equal(result.stdout.includes('"turn"'), false, label);
  }
  const late = await run('opencode', turnNative(), { turn: () => new Promise(() => {}) });
  assert.equal(late.exitCode, 0);
  assert.equal(late.stdout.includes('"turn"'), false, 'a late answer adds nothing');
});

test('routeTurnBody reads only the harness input ids and model', () => {
  const event = { nativeEventName: 'chat.message', parentSessionId: null, sessionId: 'ses_top' };
  assert.deepEqual(routeTurnBody('kilo', event, turnNative()), { harness: 'kilocode', sessionId: 'ses_top', messageId: 'msg_2', current: OPUS, modelPin: null });
  assert.deepEqual(routeTurnBody('opencode', event, turnNative({}, { messageID: undefined })), { harness: 'opencode', sessionId: 'ses_top', messageId: 'msg_2', current: OPUS, modelPin: null }, "the resolved message's id when the caller gave none");
  assert.deepEqual(routeTurnBody('opencode', event, turnNative({}, { messageID: undefined }, { model: OPUS })), { harness: 'opencode', sessionId: 'ses_top', current: OPUS, modelPin: null });
  assert.deepEqual(routeTurnBody('kilo', event, turnNative({}, { model: { providerID: 'openai', modelID: 'gpt-6-luna' } })).current, OPUS, 'the resolved model, not the input one');
  assert.equal(routeTurnBody('kilo', event, turnNative({}, {}, 'x')), null);
  assert.equal(routeTurnBody('kilo', { nativeEventName: 'chat.message', sessionId: 'ses_top' }, turnNative())?.sessionId, 'ses_top', 'a normalized event leaves a null parent out');
  assert.equal(routeTurnBody('claude', event, turnNative()), null);
  assert.equal(routeTurnBody('kilo', { ...event, sessionId: 'ses_other' }, turnNative()), null, 'the event and the input must name the same session');
  assert.equal(routeTurnBody('kilo', { ...event, parentSessionId: 'p' }, turnNative()), null);
  assert.equal(routeTurnBody('kilo', { ...event, nativeEventName: 'tool.execute.before' }, turnNative()), null);
  assert.equal(routeTurnBody('kilo', event, { input: 'x' }), null);
  assert.equal(routeTurnBody('kilo', event, 'x'), null);
  assert.equal(routeTurnBody('kilo', event, turnNative({}, {}, { id: 'msg_2', model: { providerID: 'anthropic', modelID: 'a b' } })), null);
  assert.equal(routeTurnBody('kilo', event, turnNative({}, { messageID: undefined }, { id: 'bad id', model: OPUS })), null, "a malformed resolved id asks nothing");
});
