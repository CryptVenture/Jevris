// The call meter of the Jev feature suite: it counts what leaves, numbers only, and it is the suite's
// safety net (caps, and a halt at the first 401, 402 or 403 or at three 429s in a row). Stub fetch, no network.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createCallMeter, distributionOf, percentileOf } = await import('../dist/index.js');

/** A real-shaped Jev body: an answer per question and the reported usage. */
function jevBody(questionIds, usage = { input_tokens: 1000, output_tokens: 120 }) {
  const answers = {};
  for (const id of questionIds) {
    answers[id] = id.startsWith('n')
      ? { type: 'noul', noul: 0.96 }
      : id.startsWith('s')
        ? { type: 'score', score: 0.12, probabilities: { 0: 0.89, 1: 0.11, 2: 0, 3: 0, 4: 0 }, legend: {}, confidence: 0.9 }
        : { type: 'choice', choice: 'feature', probabilities: { feature: 0.42, 'test-fix': 0.3, 'bounded-edit': 0.26 }, confidence: 0.36 };
  }
  return JSON.stringify({ model: 'jev-1.13.0', answers, usage });
}

function stub(statuses, body = () => jevBody(['c1', 's1', 'n1'])) {
  let n = 0;
  const calls = [];
  const fetch = async (_url, init) => {
    const status = statuses[Math.min(n, statuses.length - 1)];
    n += 1;
    calls.push(init.body);
    return new Response(status === 200 ? body() : '{"error":"x"}', { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const post = (meter, questions = { c1: {}, s1: {}, n1: {} }, extra = '') => meter.fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: JSON.stringify({ model: 'jev-1.13.0', state: { note: `probe${extra}` }, questions }) });

test('each request is counted with its timing, status, bytes, tokens, cost in micro-USD and the numeric shape of its answers', async () => {
  const inner = stub([200]);
  const meter = createCallMeter(inner.fetch, { maxCalls: 10, maxMicroUsd: 1000 });
  const response = await post(meter);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(await response.text()).model, 'jev-1.13.0', 'the caller still gets the whole response');
  const [row] = meter.rows;
  assert.equal(row.status, 200);
  assert.equal(row.inputTokens, 1000);
  assert.equal(row.outputTokens, 120);
  assert.equal(row.costMicroUsd, 42, '1000 input tokens at 0.042 USD per million, output free: 42 micro-USD');
  assert.equal(row.questions, 3);
  assert.ok(row.requestBytes > 0 && row.responseBytes > 0);
  assert.deepEqual(row.answers.map((a) => [a.id, a.type]), [['c1', 'choice'], ['s1', 'score'], ['n1', 'noul']]);
  const choice = row.answers.find((a) => a.type === 'choice');
  assert.deepEqual([choice.p1, choice.p2, choice.confidence], [0.42, 0.3, 0.36], 'the confidence is the provider\'s, not the top probability');
  assert.equal(row.answers.find((a) => a.type === 'score').value, 0.12);
  assert.equal(row.answers.find((a) => a.type === 'noul').value, 0.96);
  assert.deepEqual(meter.totals(), { calls: 1, refused: 0, inputTokens: 1000, outputTokens: 120, costMicroUsd: 42, statuses: { 200: 1 } });
  // Nothing of the request or the answers is kept in the row: numbers and ids only.
  assert.equal(JSON.stringify(row).includes('probe'), false);
  assert.equal(JSON.stringify(row).includes('feature'), false, 'no option name');
});

test('privacy probes: a string that must not leave is counted in the request body, and only while it is set', async () => {
  const meter = createCallMeter(stub([200]).fetch, { maxCalls: 10, maxMicroUsd: 1000 });
  meter.setProbes(['zebra-title', 'src/zebra/lexer.ts']);
  await post(meter, { c1: {} }, 'with zebra-title in it');
  meter.setProbes([]);
  await post(meter, { c1: {} }, 'with zebra-title in it');
  assert.deepEqual(meter.rows.map((r) => r.leaks), [1, 0]);
});

test('a call cap and a spend cap stop sending: the request is refused locally, nothing reaches the network, the run is halted', async () => {
  const capped = stub([200]);
  const meter = createCallMeter(capped.fetch, { maxCalls: 2, maxMicroUsd: 1_000_000 });
  await post(meter);
  await post(meter);
  await assert.rejects(post(meter), (e) => e instanceof TypeError && /refused locally: CALL_CAP/.test(e.message));
  assert.equal(capped.calls.length, 2, 'the third request never reached the inner fetch');
  assert.equal(meter.halted, 'CALL_CAP');
  assert.deepEqual([meter.totals().calls, meter.totals().refused], [2, 1]);
  const spent = stub([200]);
  const money = createCallMeter(spent.fetch, { maxCalls: 100, maxMicroUsd: 50 });
  await post(money);
  await post(money);
  await assert.rejects(post(money), (e) => /SPEND_CAP/.test(e.message));
  assert.equal(money.halted, 'SPEND_CAP');
  assert.equal(spent.calls.length, 2);
});

test('the first 401, 402 or 403 halts the run; three 429s in a row halt it, two do not', async () => {
  for (const status of [401, 402, 403]) {
    const inner = stub([status]);
    const meter = createCallMeter(inner.fetch, { maxCalls: 10, maxMicroUsd: 1000 });
    const response = await post(meter);
    assert.equal(response.status, status, 'the caller sees the status once');
    assert.equal(meter.halted, `HTTP_${String(status)}`);
    await assert.rejects(post(meter), (e) => /refused locally/.test(e.message));
    assert.equal(inner.calls.length, 1, `nothing more is sent after a ${String(status)}`);
  }
  const storm = createCallMeter(stub([429]).fetch, { maxCalls: 10, maxMicroUsd: 1000 });
  await post(storm);
  await post(storm);
  assert.equal(storm.halted, null, 'two throttles are not a storm');
  await post(storm);
  assert.equal(storm.halted, 'HTTP_429_STORM');
  const spaced = createCallMeter(stub([429, 429, 200, 429, 429]).fetch, { maxCalls: 10, maxMicroUsd: 1000 });
  for (let i = 0; i < 5; i += 1) await post(spaced);
  assert.equal(spaced.halted, null, 'a success between throttles resets the count');
});

test('a connection error is a row with no status, and the since() window and an observer work', async () => {
  const seen = [];
  const failing = async () => {
    throw new TypeError('fetch failed');
  };
  const meter = createCallMeter(failing, { maxCalls: 10, maxMicroUsd: 1000 }, undefined, () => {
    throw new Error('an observer failing changes nothing');
  });
  await assert.rejects(post(meter), TypeError);
  assert.equal(meter.rows[0].status, null);
  const ok = createCallMeter(stub([200]).fetch, { maxCalls: 10, maxMicroUsd: 1000 }, undefined, (x) => seen.push([x.n, x.status, typeof x.request, typeof x.response]));
  await post(ok);
  const from = ok.rows.length;
  await post(ok);
  assert.equal(ok.since(from).calls, 1);
  assert.deepEqual(seen, [[1, 200, 'string', 'string'], [2, 200, 'string', 'string']]);
  ok.halt('TEST_STOP');
  await assert.rejects(post(ok), (e) => /TEST_STOP/.test(e.message));
});

test('percentiles by nearest rank, and the distribution of an empty list is empty', () => {
  assert.equal(percentileOf([], 50), null);
  assert.deepEqual(distributionOf([]), { n: 0, min: null, p50: null, p95: null, p99: null, max: null });
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(distributionOf(values), { n: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100 });
  assert.deepEqual(distributionOf([5]), { n: 1, min: 5, p50: 5, p95: 5, p99: 5, max: 5 });
});
