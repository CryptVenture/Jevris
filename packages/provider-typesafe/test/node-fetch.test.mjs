// The production fetch of the Jev transport (`nodeFetch`). Measured live on 2026-10-03: Node's global
// fetch runs concurrent requests to api.typesafe.ai one at a time (four parallel requests came back at
// 201, 389, 573 and 776 ms), while four over node:https on separate sockets all took about 240 ms. So the
// default fetch of the SDK transport is `nodeFetch`: every concurrent request gets its own socket. The
// HTTP/2 queueing itself cannot be reproduced against a loopback http server, so these tests pin what the
// adapter promises: it never touches the global fetch, it runs requests in parallel, and it behaves as a
// fetch for the transport (status, headers, body, abort, a failed connection, a redirect left alone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const provider = await import('../dist/index.js');
const { nodeFetch, createSdkTransport } = provider;

const KEY = 'test-key-not-a-secret';

/** A loopback http server. `onRequest(req, res, state)` answers; `state.inFlight` and `state.peak` count the requests open at once. */
async function serve(t, onRequest) {
  const state = { inFlight: 0, peak: 0, seen: 0 };
  const server = createServer((req, res) => {
    state.inFlight += 1;
    state.seen += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    res.on('close', () => {
      state.inFlight -= 1;
    });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => onRequest(req, res, state, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, state, server };
}

test('nodeFetch sends a POST with its headers and body and returns the status, headers and body', async (t) => {
  let seen;
  const { url } = await serve(t, (req, res, _state, body) => {
    seen = { method: req.method, path: req.url, type: req.headers['content-type'], auth: req.headers.authorization, length: req.headers['content-length'], body };
    res.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_1' });
    res.end('{"ok":true}');
  });
  const payload = JSON.stringify({ model: 'jev-1.13.0', note: 'café' });
  const response = await nodeFetch(`${url}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: payload });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-typesafe-request-id'), 'req_1');
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(seen, { method: 'POST', path: '/v1/systemone', type: 'application/json', auth: `Bearer ${KEY}`, length: String(Buffer.byteLength(payload)), body: payload });
});

test('nodeFetch returns an error status with its body, an empty body for 204, and a redirect as it is', async (t) => {
  const { url } = await serve(t, (req, res) => {
    if (req.url === '/401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid api key"}');
    } else if (req.url === '/204') {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    }
  });
  const unauthorized = await nodeFetch(`${url}/401`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error, 'invalid api key');
  const empty = await nodeFetch(`${url}/204`, { method: 'POST', body: '{}' });
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
  const moved = await nodeFetch(`${url}/302`, { method: 'POST', body: '{}' });
  assert.equal(moved.status, 302, 'a redirect is not followed: the transport sees the 3xx');
  assert.equal(moved.headers.get('location'), '/elsewhere');
});

test('concurrent requests run in parallel: each one gets its own socket', async (t) => {
  const waiting = [];
  // Each answer waits until three requests are open at once, and exactly three are sent. One at a time, this would never be reached.
  const { url, state } = await serve(t, (_req, res, s) => {
    waiting.push(res);
    const release = () => {
      for (const r of waiting.splice(0)) {
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end('{"ok":true}');
      }
    };
    if (s.inFlight >= 3) release();
    else setTimeout(release, 20_000).unref();
  });
  const started = performance.now();
  const answers = await Promise.all([1, 2, 3].map((n) => nodeFetch(`${url}/v1/systemone`, { method: 'POST', body: JSON.stringify({ n }) }).then((r) => r.status)));
  assert.deepEqual(answers, [200, 200, 200]);
  assert.equal(state.peak, 3, `the server saw ${state.peak} requests open at once`);
  assert.ok(performance.now() - started < 15_000, 'the barrier released on the third open request, not on its safety timer');
});

test('an abort in flight rejects with AbortError and closes the request; an already aborted signal never sends', async (t) => {
  const { url, state } = await serve(t, () => {
    // Never answers.
  });
  const controller = new AbortController();
  const pending = nodeFetch(`${url}/v1/systemone`, { method: 'POST', body: '{}', signal: controller.signal });
  while (state.seen === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  const before = state.seen;
  const already = new AbortController();
  already.abort();
  await assert.rejects(nodeFetch(`${url}/v1/systemone`, { method: 'POST', body: '{}', signal: already.signal }), (error) => error.name === 'AbortError');
  assert.equal(state.seen, before, 'an aborted signal sends nothing');
});

test('a refused connection and a non-http URL are a TypeError "fetch failed", as undici reports them', async (t) => {
  const { url, server } = await serve(t, (_req, res) => res.end('{}'));
  const port = server.address().port;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(nodeFetch(`http://127.0.0.1:${port}/v1/systemone`, { method: 'POST', body: '{}' }), (error) => error instanceof TypeError && error.message === 'fetch failed');
  await assert.rejects(nodeFetch('file:///etc/hosts', {}), (error) => error instanceof TypeError && error.message === 'fetch failed');
  await assert.rejects(nodeFetch('not a url', {}), (error) => error instanceof TypeError && error.message === 'fetch failed');
  void url;
});

test('the SDK transport sends over nodeFetch by default and never touches the global fetch', async (t) => {
  const body = { model: 'jev-1.13.0', answers: { probe: { type: 'noul', noul: 0.96 } }, usage: { input_tokens: 294, output_tokens: 20 } };
  const waiting = [];
  const { url, state } = await serve(t, (_req, res, s) => {
    waiting.push(res);
    const release = () => {
      for (const r of waiting.splice(0)) {
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end(JSON.stringify(body));
      }
    };
    if (s.inFlight >= 3) release();
    else setTimeout(release, 20_000).unref();
  });
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the transport used the global fetch');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const transport = createSdkTransport({ apiKey: KEY, baseURL: url });
  const request = { model: 'jev-1.13.0', state: { note: 'Non-sensitive probe.' }, questions: { probe: { type: 'noul', instructions: 'Is it a probe?' } } };
  const results = await Promise.all([1, 2, 3].map(() => transport.call(request, { timeoutMs: 25_000 })));
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
  assert.equal(state.peak, 3, `the transport kept ${state.peak} requests open at once`);
  assert.equal(transport.calls, 3);
});
