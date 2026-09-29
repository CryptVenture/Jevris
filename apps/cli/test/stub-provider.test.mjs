// The loopback stub provider (OD-9, R33; interface agreed with A): each API gets a valid finished
// answer in its own shape, streamed when asked; a case may script one tool call. The stub keeps
// no body text: only the shape, model, effort, store, header names, tool names and which planted
// markers appeared. A key other than the dummy key gets 401. It listens on 127.0.0.1 only.
import test from 'node:test';
import assert from 'node:assert/strict';

const { startStubProvider, describeRequest, shapeOf, wrongKey, MAX_RECORDED, STUB_DUMMY_KEY, STUB_BODY_CAP } = await import('../dist/stub-provider.js');

async function post(stub, path, body, key = stub.dummyKey) {
  const response = await fetch(`${stub.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
  return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
}

function events(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const name = /^event: (.+)$/m.exec(block)?.[1] ?? null;
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? null;
      return { name, data: data === '[DONE]' ? data : JSON.parse(data) };
    });
}

const MARK = 'JEVRIS-PROBE-7f3a';

test('stub: Anthropic Messages, streamed and not; the record keeps no text, only the fields a case checks', async () => {
  const stub = await startStubProvider({ reply: 'stub says ok', markers: [MARK, 'absent-marker'] });
  try {
    assert.match(stub.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(stub.dummyKey, STUB_DUMMY_KEY);
    const body = { model: 'claude-haiku-4-5', stream: true, system: [{ type: 'text', text: 'You are Claude Code.' }, { type: 'text', text: `note ${MARK}` }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hello secret source text' }] }], tools: [{ name: 'Agent', input_schema: {} }, { name: 'Bash', input_schema: {} }], output_config: { effort: 'low' } };
    const streamed = await post(stub, '/v1/messages?beta=true', body);
    assert.equal(streamed.status, 200);
    assert.equal(streamed.type, 'text/event-stream');
    const list = events(streamed.text);
    assert.deepEqual(list.map((event) => event.name), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(list[2].data.delta.text, 'stub says ok');
    assert.equal(list[0].data.message.model, 'claude-haiku-4-5');
    const plain = JSON.parse((await post(stub, '/v1/messages', { ...body, stream: false })).text);
    assert.deepEqual([plain.type, plain.content[0].text, plain.stop_reason], ['message', 'stub says ok', 'end_turn']);
    assert.deepEqual(JSON.parse((await post(stub, '/v1/messages/count_tokens', body)).text), { input_tokens: 1 });
    const [first] = stub.requests();
    assert.equal(typeof first.atMs, 'number');
    assert.deepEqual({ ...first, atMs: 0 }, { shape: 'anthropic-messages', path: '/v1/messages?beta=true', model: 'claude-haiku-4-5', effort: 'low', stream: true, store: null, atMs: 0, headerNames: first.headerNames, toolNames: ['Agent', 'Bash'], markersSeen: [{ marker: MARK, where: 'system' }], refused: false });
    assert.ok(first.headerNames.includes('x-api-key') && first.headerNames.includes('content-type'));
    const all = JSON.stringify(stub.requests());
    assert.equal(all.includes(stub.dummyKey), false, 'no header value is recorded');
    assert.equal(all.includes('secret source text') || all.includes('You are Claude Code'), false, 'no body text is recorded');
    const budget = describeRequest('anthropic-messages', '/v1/messages', { thinking: { type: 'enabled', budget_tokens: 2048 } });
    assert.equal(budget.effort, 'budget:2048');
  } finally {
    await stub.close();
  }
});

test('stub: a key other than the dummy key is refused with 401, and recorded as refused', async () => {
  const stub = await startStubProvider();
  try {
    const wrong = await post(stub, '/v1/messages', { model: 'm', messages: [] }, 'sk-some-real-looking-key');
    assert.equal(wrong.status, 401);
    const [record] = stub.requests();
    assert.deepEqual([record.refused, record.model], [true, null], 'a refused body is not even read');
    assert.equal(JSON.stringify(stub.requests()).includes('sk-some'), false);
  } finally {
    await stub.close();
  }
  assert.equal(wrongKey({ authorization: `Bearer ${STUB_DUMMY_KEY}` }, STUB_DUMMY_KEY), false);
  assert.equal(wrongKey({ authorization: 'Bearer other' }, STUB_DUMMY_KEY), true);
  assert.equal(wrongKey({}, STUB_DUMMY_KEY), false, 'no key at all is not a wrong key');
});

test('stub: OpenAI Responses (Codex), with markers in instructions or developer text, reasoning effort and store', async () => {
  const stub = await startStubProvider({ markers: [MARK] });
  try {
    const body = { model: 'gpt-5.5', stream: true, store: false, instructions: 'base', reasoning: { effort: 'high' }, tools: [{ type: 'function', name: 'spawn_agent' }, { type: 'web_search' }], input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: MARK }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] }] };
    const list = events((await post(stub, '/v1/responses', body)).text);
    assert.deepEqual(list.map((event) => event.name), ['response.created', 'response.output_item.added', 'response.output_text.delta', 'response.output_item.done', 'response.completed']);
    assert.deepEqual(list.map((event) => event.data.type), list.map((event) => event.name), 'each data type repeats its event name');
    const completed = list.at(-1).data.response;
    assert.deepEqual([completed.status, completed.usage.total_tokens, completed.output[0].content[0].text], ['completed', 2, 'ok']);
    const [record] = stub.requests();
    assert.deepEqual([record.shape, record.model, record.effort, record.store, record.toolNames, record.markersSeen], ['openai-responses', 'gpt-5.5', 'high', false, ['spawn_agent', 'web_search'], [{ marker: MARK, where: 'system' }]]);
  } finally {
    await stub.close();
  }
});

test('stub: a Responses tool namespace is listed by name and per tool; a scripted call can name its namespace', async () => {
  const script = (request) => (request.toolNames.includes('collaboration.spawn_agent') ? { kind: 'tool', name: 'spawn_agent', input: { message: 'm' }, namespace: 'collaboration' } : undefined);
  const stub = await startStubProvider({ script });
  try {
    const tools = [{ type: 'namespace', name: 'collaboration', description: 'agents', tools: [{ type: 'function', name: 'spawn_agent' }, { type: 'function', name: 'wait_agent' }, { type: 'function' }] }, { type: 'function', name: 'exec_command' }];
    const plain = JSON.parse((await post(stub, '/v1/responses', { model: 'gpt-6-astra', tools, input: [] })).text);
    assert.deepEqual(plain.output[0], { type: 'function_call', id: 'fc_1', call_id: 'call_stub_1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"message":"m"}', status: 'completed' });
    const streamed = events((await post(stub, '/v1/responses', { model: 'gpt-6-astra', stream: true, tools, input: [] })).text);
    assert.equal(streamed.find((event) => event.name === 'response.output_item.done').data.item.namespace, 'collaboration');
    assert.deepEqual(stub.requests()[0].toolNames, ['collaboration', 'collaboration.spawn_agent', 'collaboration.wait_agent', 'exec_command'], 'a member with no name is skipped');
    const chat = await post(stub, '/v1/chat/completions', { model: 'glm-5', tools: [{ type: 'namespace', name: 'collaboration', tools: [{ name: 'spawn_agent' }] }], messages: [] });
    assert.equal(chat.status, 200);
    assert.deepEqual(stub.requests()[2].toolNames, [], 'only a Responses request has namespaces');
    const unscripted = JSON.parse((await post(stub, '/v1/responses', { model: 'gpt-6-astra', tools: [{ type: 'function', name: 'spawn_agent' }], input: [] })).text);
    assert.equal(Object.hasOwn(unscripted.output[0], 'namespace'), false, 'a plain answer names no namespace');
  } finally {
    await stub.close();
  }
});

test('stub: OpenAI-compatible Chat Completions, streamed with [DONE]; the model listing; unknown paths', async () => {
  const stub = await startStubProvider({ models: ['claude-haiku-4-5', 'claude-opus-5-5'], markers: [MARK] });
  try {
    const body = { model: 'glm-5', stream: true, reasoning_effort: 'medium', tools: [{ type: 'function', function: { name: 'task' } }], messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: `hi ${MARK}` }] };
    const list = events((await post(stub, '/v1/chat/completions', body)).text);
    assert.equal(list.at(-1).data, '[DONE]');
    assert.equal(list[1].data.choices[0].delta.content, 'ok');
    assert.equal(list[2].data.choices[0].finish_reason, 'stop');
    const plain = JSON.parse((await post(stub, '/chat/completions', { ...body, stream: false })).text);
    assert.equal(plain.choices[0].message.content, 'ok');
    const [record] = stub.requests();
    assert.deepEqual([record.shape, record.effort, record.toolNames, record.markersSeen], ['openai-chat', 'medium', ['task'], [{ marker: MARK, where: 'messages' }]]);
    const models = await (await fetch(`${stub.baseUrl}/v1/models`)).json();
    assert.deepEqual(models.data.map((entry) => entry.id), ['claude-haiku-4-5', 'claude-opus-5-5']);
    const missing = await fetch(`${stub.baseUrl}/v1/other`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
    await missing.text();
    assert.equal(stub.requests().at(-1).shape, 'unknown');
  } finally {
    await stub.close();
  }
});

test('stub: a scripted tool call in each API shape; later requests fall back to the reply', async () => {
  const script = (request, seq) => (seq === 1 ? { kind: 'tool', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'look' } } : undefined);
  for (const [path, body, check] of [
    ['/v1/messages', { model: 'm', stream: true, messages: [] }, (list) => {
      assert.deepEqual(list[1].data.content_block, { type: 'tool_use', id: 'toolu_stub_1', name: 'Agent', input: {} });
      assert.equal(JSON.parse(list[2].data.delta.partial_json).subagent_type, 'Explore');
      assert.equal(list[4].data.delta.stop_reason, 'tool_use');
    }],
    ['/v1/responses', { model: 'm', stream: true, input: [] }, (list) => {
      assert.equal(list[2].name, 'response.function_call_arguments.delta');
      assert.deepEqual([list[3].data.item.type, list[3].data.item.name, JSON.parse(list[3].data.item.arguments).prompt], ['function_call', 'Agent', 'look']);
    }],
    ['/v1/chat/completions', { model: 'm', stream: true, messages: [] }, (list) => {
      assert.equal(list[1].data.choices[0].delta.tool_calls[0].function.name, 'Agent');
      assert.equal(list[2].data.choices[0].finish_reason, 'tool_calls');
    }],
  ]) {
    const stub = await startStubProvider({ script });
    try {
      check(events((await post(stub, path, body)).text));
      const second = events((await post(stub, path, body)).text);
      assert.equal(JSON.stringify(second).includes('"ok"'), true, 'the second request gets the plain reply');
    } finally {
      await stub.close();
    }
  }
});

test('stub: a bad body is recorded with no model; shapes by method and path; bounds', async () => {
  const stub = await startStubProvider();
  try {
    const response = await fetch(`${stub.baseUrl}/v1/messages`, { method: 'POST', body: 'not json' });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(stub.requests()[0].model, null);
  } finally {
    await stub.close();
  }
  assert.equal(describeRequest('openai-chat', '/x', 'text').model, null, 'never throws on a non-object body');
  assert.deepEqual([shapeOf('POST', '/v1/messages'), shapeOf('GET', '/v1/models/claude-x'), shapeOf('GET', '/v1/messages'), shapeOf('POST', '/api/v1/chat/completions')], ['anthropic-messages', 'models', 'unknown', 'openai-chat']);
  assert.deepEqual([MAX_RECORDED, STUB_BODY_CAP], [256, 8 * 1024 * 1024]);
});
