import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { load, story } from './lib.mjs';

// The sidecar wire protocol v1 (SSOT §16.3, IPC-01..03), reimplemented here from its
// published constants so the story drives the running daemon as an outside client would.
const DOMAIN = 'jevris-sidecar-v1';
const nonce = () => randomBytes(16).toString('base64url');
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest('base64url');
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const requestMac = (key, f) => hmac(key, [DOMAIN, 'request', f.snonce, f.id, f.ws, f.op, String(f.ts), '', f.budget, sha256Hex(f.body)].join('\n'));

/** Opens one connection, writes `lines` in turn (a function receives the previous reply), and collects every reply line. */
function converse(endpoint, steps, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    const replies = [];
    let buffer = '';
    let step = 0;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(replies);
    };
    const timer = setTimeout(finish, timeoutMs);
    const send = () => {
      if (step >= steps.length) return;
      const next = steps[step++];
      const text = typeof next === 'function' ? next(replies.at(-1)) : next;
      if (text === null) return finish();
      socket.write(text);
    };
    socket.on('connect', send);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          replies.push(JSON.parse(line));
        } catch {
          replies.push({ raw: line });
        }
        if (step >= steps.length) finish();
        else send();
      }
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

const hello = (client = 'cli') => `${JSON.stringify({ t: 'hello', v: 1, client, cnonce: nonce() })}\n`;

function signedRequest(key, snonce, { op, ws, body }) {
  const frame = { id: nonce(), ws, op, ts: Date.now(), budget: 'background', body: JSON.stringify(body) };
  return { ...frame, t: 'req', v: 1, eventAtMs: null, mac: requestMac(key, { snonce, ...frame }) };
}

story('US27', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const started = box.startSidecar();
  assert.equal(started.code, 0, `sidecar start failed: ${started.stderr}`);
  const { jevrisPaths } = await load('platform');
  const paths = jevrisPaths({ home: box.home });
  const endpointFile = JSON.parse(readFileSync(join(paths.runtime, 'endpoint.json'), 'utf8'));
  const endpoint = endpointFile.endpoint;
  const cliKey = Buffer.from(readFileSync(join(paths.runtime, 'key-cli'), 'utf8').trim(), 'base64url');
  const submit = { op: 'task.submit', ws: box.work, body: { title: 'forged', workspace: box.work } };

  // 1. A browser page: an HTTP request with a localhost Host and a foreign Origin.
  const browser = await converse(endpoint, [`GET /v1/task.submit HTTP/1.1\r\nHost: localhost\r\nOrigin: http://evil.example\r\n\r\n`, null]);
  // 2. A local process with no key: a correct handshake, then a request signed with a guessed key.
  const guessed = await converse(endpoint, [hello(), (challenge) => `${JSON.stringify(signedRequest(randomBytes(32), challenge.snonce, submit))}\n`]);
  // 3. A request without any MAC.
  const unsigned = await converse(endpoint, [hello(), (challenge) => {
    const { mac: _mac, ...rest } = signedRequest(cliKey, challenge.snonce, submit);
    return `${JSON.stringify(rest)}\n`;
  }]);
  // 4. Replay: a valid signed health request, sent twice on its connection and once more on a new one.
  let captured = '';
  const first = await converse(endpoint, [hello(), (challenge) => {
    captured = `${JSON.stringify(signedRequest(cliKey, challenge.snonce, { op: 'health', ws: '', body: null }))}\n`;
    return captured;
  }, () => captured]);
  const replayed = await converse(endpoint, [hello(), () => captured]);
  // 5. A hook key presenting a request for an administration op.
  const hookKey = Buffer.from(readFileSync(join(paths.runtime, 'key-hook'), 'utf8').trim(), 'base64url');
  const hookAdmin = await converse(endpoint, [hello('hook'), (challenge) => `${JSON.stringify(signedRequest(hookKey, challenge.snonce, { op: 'store.backup', ws: '', body: { path: join(box.home, 'b.db') } }))}\n`]);
  evidence({ browser, guessed, unsigned, first, replayed, hookAdmin });

  const status = box.jevris(['sidecar', 'status', '--home', box.home], { json: true });
  // The sidecar writes its log asynchronously (a write that fails for a moment is tried again, a slow disk lands late), so a
  // read right after the requests can miss their lines. Wait, with a generous bound, until the two rejects asserted below are in it.
  const logPath = join(paths.state, 'logs', 'sidecar.log');
  const rejected = () => {
    try {
      const text = readFileSync(logPath, 'utf8');
      return ['BAD_MAC', 'REPLAYED'].every((code) => text.includes(`"event":"reject","reasonCode":"${code}"`));
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 6_000 && !rejected(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const logText = readFileSync(logPath, 'utf8');
  const log = logText.trim().split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

  await then('The service rejects it without reading source or launching work', () => {
    assert.equal(browser.some((reply) => reply.t === 'challenge' || reply.t === 'res'), false, `a browser request got an answer: ${JSON.stringify(browser)}`);
    assert.equal(browser.at(-1)?.reasonCode, 'MALFORMED');
    assert.deepEqual(guessed.map((reply) => reply.t), ['challenge', 'error']);
    assert.equal(guessed[1].reasonCode, 'BAD_MAC');
    assert.equal(unsigned[1]?.t, 'error');
    assert.match(unsigned[1].reasonCode, /^(BAD_MAC|MALFORMED)$/);
    assert.equal(first[1]?.t, 'res', 'the genuine signed request was not answered');
    assert.equal(first[2]?.t, 'error');
    assert.equal(first[2].reasonCode, 'REPLAYED');
    assert.equal(replayed[1]?.t, 'error', 'a request replayed on a new connection was answered');
    assert.equal(replayed[1].reasonCode, 'BAD_MAC');
    assert.equal(hookAdmin[1]?.t, 'res');
    // The refusals are logged as rejects; none of them reached an operation.
    const rejects = log.filter((entry) => entry.event === 'reject').map((entry) => entry.reasonCode);
    for (const code of ['BAD_MAC', 'REPLAYED']) assert.ok(rejects.includes(code), `no ${code} reject was logged`);
    const dispatched = log.filter((entry) => entry.event === 'request').map((entry) => entry.op);
    assert.equal(dispatched.includes('task.submit'), false, 'a forged task.submit reached dispatch');
    // No task and no worker exist, and the forged title never reached the store or the logs.
    assert.equal(logText.includes('forged'), false);
    assert.equal(status.code, 0, status.stderr);
    const db = join(paths.data, 'jevris.db');
    if (existsSync(db)) assert.equal(readFileSync(db).includes(Buffer.from('forged')), false, 'the forged task reached the store');
    assert.equal(existsSync(join(box.work, '.jevris', 'tasks')), false);
  });

  await then('localhost alone is not trusted', () => {
    // Nothing listens on TCP: the endpoint is a Unix socket path or a named pipe.
    assert.equal(/^(tcp|https?):|^[\d.]+:\d+$|^localhost/i.test(endpoint), false, `endpoint is a network address: ${endpoint}`);
    const pipe = endpoint.startsWith('\\\\.\\pipe\\');
    assert.ok(pipe || isAbsolute(endpoint), endpoint);
    // A local connection is still refused without the per-kind key, and the hook key cannot administer.
    const hookOutcome = JSON.parse(hookAdmin[1].payload);
    assert.equal(hookOutcome.ok, false);
    assert.equal(hookOutcome.reasonCode, 'SCOPE_DENIED');
    if (process.platform !== 'win32') {
      // Another OS user cannot reach the socket or read a key: the directory and keys are owner-only.
      assert.equal(statSync(dirname(endpoint)).mode & 0o077, 0, 'the socket directory is reachable by other users');
      for (const kind of ['cli', 'hook', 'mcp']) assert.equal(statSync(join(paths.runtime, `key-${kind}`)).mode & 0o077, 0, `key-${kind} is readable by other users`);
      assert.equal(statSync(endpoint).uid, process.getuid());
    }
  });
});
