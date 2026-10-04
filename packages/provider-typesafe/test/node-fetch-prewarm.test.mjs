// The Jev connection, ready before the first request. Measured live on 2026-10-04: a request on a connection that
// was already open answered 50 to 110 ms sooner than one that had to open it (TCP and TLS), and the first request
// of a fresh sidecar paid it. `prewarmConnection` opens the connection ahead of time. It sends no request and no
// data, the next request takes it, it is closed when nobody does, and it never keeps the process alive.
// The pool also keeps an idle connection longer (30 s, measured safe on the live API for 120 s) and drops what a
// machine that slept left half-open. These tests run against a loopback http server: the pool code is the same
// for https, whose TLS handshake only makes the saving larger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const nodeFetchModule = await import('../dist/node-fetch.js');
const { nodeFetch, prewarmConnection, prewarmedConnections, closePrewarmed, IDLE_SOCKET_MS, SPARE_SOCKET_MS } = nodeFetchModule;

/** A loopback http server that records every connection (with the bytes it has received) and every request's socket. */
async function serve(t) {
  const state = { connections: [], requests: [] };
  const server = createServer((req, res) => {
    state.requests.push({ port: req.socket.remotePort, url: req.url });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('connection', (socket) => {
    const row = { port: socket.remotePort, closed: false, socket };
    state.connections.push(row);
    socket.on('close', () => {
      row.closed = true;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    closePrewarmed();
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, state, server };
}

const until = async (condition, what) => {
  for (let i = 0; i < 1200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};

// The body is read to the end: a connection goes back to the pool only then, as in the transport.
const post = async (url) => {
  const response = await nodeFetch(`${url}/v1/systemone`, { method: 'POST', body: '{}' });
  await response.arrayBuffer();
  return response.status;
};

test('prewarmConnection opens one connection and sends nothing on it', async (t) => {
  const { url, state } = await serve(t);
  assert.equal(await prewarmConnection(url), true);
  await until(() => state.connections.length === 1, 'the server to accept the connection');
  assert.equal(prewarmedConnections(), 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(state.requests.length, 0, 'no request');
  assert.equal(state.connections[0].socket.bytesRead, 0, 'not one byte');
});

test('the next request takes the waiting connection; no second connection is opened', async (t) => {
  const { url, state } = await serve(t);
  assert.equal(await prewarmConnection(url), true);
  await until(() => state.connections.length === 1, 'the connection');
  const port = state.connections[0].port;
  assert.equal(await post(url), 200);
  assert.deepEqual(state.requests.map((r) => r.port), [port], 'the request arrived on the connection that was opened ahead');
  assert.equal(state.connections.length, 1, 'and nothing else was opened');
  assert.equal(prewarmedConnections(), 0, 'it is the pool\'s now');
  // The pool keeps it: the next request reuses it too.
  assert.equal(await post(url), 200);
  assert.deepEqual(state.requests.map((r) => r.port), [port, port]);
  assert.equal(state.connections.length, 1);
});

test('asking again while one waits, or while the pool holds an idle one, opens nothing', async (t) => {
  const { url, state } = await serve(t);
  assert.equal(await prewarmConnection(url), true);
  assert.equal(await prewarmConnection(url), true);
  await until(() => state.connections.length === 1, 'the connection');
  assert.equal(await post(url), 200);
  assert.equal(await prewarmConnection(url), true, 'the pool already holds an idle connection to it');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(state.connections.length, 1);
});

test('a waiting connection the other end closes is dropped, and the next request connects as usual', async (t) => {
  const { url, state } = await serve(t);
  assert.equal(await prewarmConnection(url), true);
  await until(() => state.connections.length === 1, 'the connection');
  state.connections[0].socket.destroy();
  await until(() => prewarmedConnections() === 0, 'the client to see the close');
  assert.equal(await post(url), 200);
  assert.equal(state.connections.length, 2, 'a new connection');
  assert.equal(state.requests.length, 1);
});

test('closePrewarmed closes what nobody took', async (t) => {
  const { url, state } = await serve(t);
  assert.equal(await prewarmConnection(url), true);
  await until(() => state.connections.length === 1, 'the connection');
  closePrewarmed();
  assert.equal(prewarmedConnections(), 0);
  await until(() => state.connections[0].closed, 'the server to see the close');
});

test('a refused connection, a bad URL and a URL that is not http answer false and leave nothing behind', async (t) => {
  const { url, server } = await serve(t);
  const port = server.address().port;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await prewarmConnection(`http://127.0.0.1:${port}`), false);
  assert.equal(await prewarmConnection('not a url'), false);
  assert.equal(await prewarmConnection('file:///etc/hosts'), false);
  assert.equal(prewarmedConnections(), 0);
  void url;
});

test('a connection that never becomes ready is given up at the timeout', async (t) => {
  // A listener that accepts and never speaks is a ready TCP connection, so this uses an address that does not answer:
  // the timeout is what ends the attempt, and it answers false.
  const { createServer: createNet } = await import('node:net');
  const server = createNet({ pauseOnConnect: true }, () => undefined);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  // Plain http is ready at TCP connect, so the silent listener is ready; the same listener under https never completes TLS.
  const warmed = await prewarmConnection(`https://127.0.0.1:${server.address().port}`, { timeoutMs: 300 });
  assert.equal(warmed, false, 'TLS never completed');
  assert.equal(prewarmedConnections(), 0);
});

test('an idle connection is kept for 30 s, and a waiting spare for less than that', () => {
  assert.equal(IDLE_SOCKET_MS, 30_000);
  assert.ok(SPARE_SOCKET_MS < IDLE_SOCKET_MS);
});

test('after the machine slept (the wall clock jumped, the monotonic clock did not) the idle connection is dropped, not reused', async (t) => {
  const { url, state } = await serve(t);
  assert.equal(await post(url), 200);
  assert.equal(await post(url), 200);
  assert.equal(state.connections.length, 1, 'the second request reused the first connection');
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  Date.now = () => realNow() + 60_000; // pinned-clock: a minute passes on the wall clock only, as in a sleep
  assert.equal(await post(url), 200);
  assert.equal(state.connections.length, 2, 'a new connection: the idle one was closed, not trusted');
  await until(() => state.connections[0].closed, 'the old connection to close');
  Date.now = realNow;
  assert.equal(await post(url), 200);
  assert.equal(state.connections.length, 2, 'and with no sleep the new one is reused');
});
