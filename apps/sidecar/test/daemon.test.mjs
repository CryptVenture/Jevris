import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync as spawnSyncChild } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { startDaemon: startDaemonOnce, loadOps, DuplicateOpError, sidecarRequest, ensureSidecar, stopSidecarProcess, probeSidecar, NonceCache, runtimeFiles, sweepStaleFallbackSockets, sidecarWaitMs, SIDECAR_TEST_WAIT_MAX_MS } =
  await import('../dist/index.js');
const protocol = await import('../dist/protocol.js');
const { jevrisPaths } = await import('@jevris/platform');

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, '..', 'dist', 'main.js');
const posix = process.platform !== 'win32';

/**
 * Sidecar children this file spawns. Each test ends its own in a finally; the file-level after()
 * ends any left, so a failed assertion never leaves a sidecar holding the file's process (and the
 * host suite lock) open.
 */
const children = new Set();

/** A sidecar child of `home`, tracked for cleanup. */
function spawnSidecar(home) {
  const child = spawn(process.execPath, [MAIN, '--home', home, '--idle-ms', '0'], { stdio: 'ignore' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

/** The child's exit [code, signal], or null when it has not exited within `ms`. */
function exitOf(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    });
  });
}

/** Ends a child that is still running: SIGTERM, then SIGKILL after a bound. */
async function endChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if ((await exitOf(child, 5000)) === null) {
    child.kill('SIGKILL');
    await exitOf(child, 5000);
  }
}

/** In-process daemons this file starts; stop() is idempotent, so after() stops any a test left. */
const daemons = new Set();

async function startDaemon(options) {
  const started = await startDaemonOnce(options);
  if (started.ok) daemons.add(started.daemon);
  return started;
}

after(async () => {
  for (const child of [...children]) await endChild(child);
  for (const daemon of [...daemons]) await daemon.stop('test-cleanup').catch(() => undefined);
});

/**
 * Waits for the child's endpoint file to be readable. A loaded host can take several seconds to
 * start a sidecar (the store, the engine and the ops load before the endpoint is written), so the
 * bound is 30 s, not the 5 s that once failed under a full-suite load.
 */
async function endpointOf(files, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(files.endpoint)) {
      const endpoint = protocol.readEndpoint(files);
      if (endpoint !== undefined) return endpoint;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

function tempHome(prefix = 'jvd') {
  // realpath: macOS tmpdir is a symlink; a short base keeps the socket path under 103 bytes.
  return realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
}

async function withDaemon(options, fn) {
  const home = options.home ?? tempHome();
  const logs = [];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: (entry) => logs.push(entry), ...options });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    return await fn({ home, daemon: started.daemon, logs });
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
}

/** A raw protocol client, for frames the real client would never send. */
async function rawSession(home, kind = 'cli') {
  const files = runtimeFiles({ home });
  const endpoint = protocol.readEndpoint(files);
  const key = protocol.readClientKey(files, kind);
  const socket = net.connect(endpoint.endpoint);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const lines = [];
  const waiters = [];
  let buffer = '';
  let closed = false;
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(JSON.parse(line));
      else lines.push(JSON.parse(line));
    }
  });
  socket.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()(null);
  });
  const next = () =>
    new Promise((resolve) => {
      if (lines.length > 0) resolve(lines.shift());
      else if (closed) resolve(null);
      else waiters.push(resolve);
    });
  const cnonce = protocol.newNonce();
  socket.write(`${JSON.stringify({ t: 'hello', v: 1, client: kind, cnonce })}\n`);
  const challenge = await next();
  assert.equal(challenge.t, 'challenge');
  assert.equal(challenge.proof, protocol.serverProof(key, cnonce, challenge.snonce, challenge.bootId));
  const frame = (op, body = {}, extra = {}) => {
    const id = extra.id ?? protocol.newNonce();
    const ts = extra.ts ?? Date.now();
    const text = JSON.stringify(body);
    const ws = extra.ws ?? '';
    const budget = extra.budget ?? 'background';
    const eventAtMs = extra.eventAtMs ?? null;
    const mac = extra.mac ?? protocol.requestMac(extra.key ?? key, { snonce: challenge.snonce, id, ws, op, ts, eventAtMs, budget, body: text });
    return { t: 'req', v: 1, id, ws, op, ts, eventAtMs, budget, body: text, mac };
  };
  const send = async (value) => {
    socket.write(`${JSON.stringify(value)}\n`);
    return next();
  };
  return { socket, frame, send, next, close: () => socket.destroy(), snonce: challenge.snonce, key };
}

function payload(res) {
  return JSON.parse(res.payload);
}

test('a running sidecar answers every client kind, and the endpoint, keys and socket are private (IPC-01, IPC-11)', async () => {
  await withDaemon({}, async ({ home, daemon }) => {
    for (const scope of ['cli', 'hook', 'mcp']) {
      const res = await sidecarRequest({ home, op: 'ping', scope });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.result.pong, true);
    }
    const files = runtimeFiles({ home });
    const endpoint = JSON.parse(readFileSync(files.endpoint, 'utf8'));
    assert.equal(endpoint.pid, process.pid);
    assert.equal(endpoint.endpoint, daemon.endpoint.endpoint);
    if (posix) {
      for (const path of [files.endpoint, files.pid, files.key('cli'), files.key('hook'), files.key('mcp'), endpoint.endpoint]) {
        assert.equal(statSync(path).mode & 0o077, 0, `${path} is owner-only`);
      }
      assert.equal(statSync(files.dir).mode & 0o077, 0);
    }
    // The endpoint and keys hold no environment token; JEVRIS_HOOK_* is not used.
    assert.equal(readFileSync(files.endpoint, 'utf8').includes('token'), false);
  });
});

test('1,000 sequential fresh frames are accepted over one sidecar lifetime (IPC-01)', async () => {
  await withDaemon({}, async ({ home }) => {
    const session = await rawSession(home, 'cli');
    for (let i = 0; i < 1000; i += 1) {
      const res = await session.send(session.frame('ping'));
      assert.equal(res.t, 'res');
      assert.equal(payload(res).ok, true);
    }
    session.close();
  });
});

test('a replayed nonce is rejected before dispatch for submit, cancel, optimize, complete and status (IPC-02)', async () => {
  const calls = [];
  const effect = (op) => ({ op, scope: 'status', budget: 'background', workspace: 'optional', handle: () => (calls.push(op), { ok: true, body: { ran: op } }) });
  await withDaemon({ ops: ['submit', 'cancel', 'optimize', 'complete'].map(effect) }, async ({ home }) => {
    for (const op of ['submit', 'cancel', 'optimize', 'complete', 'ping']) {
      const session = await rawSession(home);
      const frame = session.frame(op);
      const first = await session.send(frame);
      assert.equal(payload(first).ok, true);
      const replay = await session.send(frame);
      assert.deepEqual(replay, { t: 'error', id: frame.id, reasonCode: 'REPLAYED' });
      session.close();
      // The same frame on a new connection fails its MAC: the server nonce differs.
      const other = await rawSession(home);
      const again = await other.send(frame);
      assert.equal(again.reasonCode, 'BAD_MAC');
      other.close();
    }
    assert.deepEqual(calls, ['submit', 'cancel', 'optimize', 'complete']);
  });
});

test('an expired, future, tampered or wrong-key frame is refused (IPC-01)', async () => {
  await withDaemon({}, async ({ home }) => {
    const cases = [
      [(s) => s.frame('ping', {}, { ts: Date.now() - 60_000 }), 'EXPIRED'],
      [(s) => s.frame('ping', {}, { ts: Date.now() + 60_000 }), 'CLOCK_SKEW'],
      [(s) => ({ ...s.frame('ping'), body: '{"x":1}' }), 'BAD_MAC'],
      [(s) => s.frame('ping', {}, { key: new Uint8Array(32) }), 'BAD_MAC'],
      [(s) => ({ ...s.frame('ping'), id: 'short' }), 'MALFORMED'],
    ];
    for (const [make, code] of cases) {
      const session = await rawSession(home);
      const res = await session.send(make(session));
      assert.equal(res.t, 'error');
      assert.equal(res.reasonCode, code);
      session.close();
    }
    // A hook key cannot sign as the CLI.
    const files = runtimeFiles({ home });
    const hookKey = protocol.readClientKey(files, 'hook');
    const session = await rawSession(home, 'cli');
    const res = await session.send(session.frame('shutdown', {}, { key: hookKey }));
    assert.equal(res.reasonCode, 'BAD_MAC');
    session.close();
  });
});

test('the client refuses a server that cannot prove the key and sends it nothing (IPC-03)', async () => {
  const home = tempHome();
  try {
    const files = runtimeFiles({ home });
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\jevris-test-${process.pid}-squat` : join(files.dir, 's');
    const seen = [];
    const squatter = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
          const value = JSON.parse(line);
          seen.push(value.t);
          if (value.t === 'hello') {
            socket.write(`${JSON.stringify({ t: 'challenge', v: 1, protocol: 1, version: '0.1.0', bootId: 'squatboot1', snonce: protocol.newNonce(), proof: 'AAAA' })}\n`);
          }
        }
      });
    });
    await new Promise((resolve) => squatter.listen(endpoint, resolve));
    writeFileSync(files.endpoint, JSON.stringify({ schemaVersion: 'jevris-sidecar-endpoint-1', protocol: 1, version: '0.1.0', pid: process.pid, bootId: 'squatboot1', endpoint, startedAtMs: Date.now(), supervised: false }), { mode: 0o600 });
    writeFileSync(files.key('cli'), `${Buffer.alloc(32, 7).toString('base64url')}\n`, { mode: 0o600 });
    const res = await sidecarRequest({ home, op: 'status', scope: 'cli', body: { secret: 'not-sent' } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'refused');
    assert.equal(res.reasonCode, 'SERVER_UNPROVEN');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen, ['hello']);
    await new Promise((resolve) => squatter.close(resolve));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP and hook scopes cannot submit or administer; an unknown op and a missing workspace are refused (IPC-10)', async () => {
  const submit = { op: 'task.submit.test', scope: 'submit', budget: 'background', workspace: 'optional', handle: () => ({ ok: true, body: {} }) };
  await withDaemon({ ops: [submit] }, async ({ home }) => {
    for (const scope of ['mcp', 'hook']) {
      for (const op of ['shutdown', 'task.submit.test']) {
        const res = await sidecarRequest({ home, op, scope });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'rejected');
        assert.equal(res.reasonCode, 'SCOPE_DENIED', `${scope} ${op}`);
      }
    }
    assert.equal((await sidecarRequest({ home, op: 'task.submit.test', scope: 'cli' })).ok, true);
    assert.equal((await sidecarRequest({ home, op: 'no.such-op', scope: 'cli' })).reasonCode, 'UNKNOWN_OP');
    assert.equal((await sidecarRequest({ home, op: 'workspace.register', scope: 'cli' })).reasonCode, 'UNKNOWN_WORKSPACE');
    assert.equal((await sidecarRequest({ home, op: 'workspace.register', scope: 'cli', workspace: 'wnotregistered' })).reasonCode, 'UNKNOWN_WORKSPACE');
  });
});

test('workspaces register by root identity, not path (IPC-09)', async () => {
  await withDaemon({}, async ({ home }) => {
    const root = join(home, 'repo');
    mkdirSync(root);
    const first = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    assert.equal(first.ok, true);
    assert.match(first.result.id, /^w[0-9a-f]{24}$/);
    const byId = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: first.result.id });
    assert.deepEqual(byId.result, first.result);
    const viaDot = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: join(root, '.') });
    assert.equal(viaDot.result.id, first.result.id);
    const other = join(home, 'other');
    mkdirSync(other);
    const second = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: other });
    assert.notEqual(second.result.id, first.result.id);
  });
});

test('a slow-read client times out and the connection cap holds (IPC-04)', async () => {
  await withDaemon({ limits: { maxConnections: 2, helloMs: 150, frameMs: 150 } }, async ({ home }) => {
    const files = runtimeFiles({ home });
    const endpoint = protocol.readEndpoint(files).endpoint;
    const slow = net.connect(endpoint);
    await new Promise((resolve) => slow.once('connect', resolve));
    slow.write('{"t":"hel');
    const closedAt = Date.now();
    await new Promise((resolve) => slow.once('close', resolve));
    assert.ok(Date.now() - closedAt < 2000);

    const held = [net.connect(endpoint), net.connect(endpoint)];
    await Promise.all(held.map((s) => new Promise((resolve) => s.once('connect', resolve))));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // K7: every refused connection reads the BUSY line before the close, never a bare CLOSED.
    const refused = await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve) => {
      const third = net.connect(endpoint);
      let data = '';
      third.on('data', (chunk) => (data += chunk.toString('utf8')));
      third.on('close', () => resolve(data));
      third.on('error', () => resolve(data));
    })));
    for (const text of refused) assert.match(text, /"reasonCode":"BUSY"/);
    for (const s of held) s.destroy();
  });
});

test('the nonce cache is TTL-bounded and refuses rather than grows (IPC-04)', () => {
  const cache = new NonceCache(1000, 3);
  assert.equal(cache.consume('a', 0), 'fresh');
  assert.equal(cache.consume('a', 10), 'replayed');
  assert.equal(cache.consume('b', 0), 'fresh');
  assert.equal(cache.consume('c', 0), 'fresh');
  assert.equal(cache.consume('d', 10), 'full');
  assert.equal(cache.consume('d', 2000), 'fresh');
  assert.ok(cache.size <= 3);
});

test('a request deadline counts from event receipt on the monotonic clock and aborts in-flight work (IPC-15)', async () => {
  let abortedReason;
  const wait = {
    op: 'test.wait',
    scope: 'status',
    budget: 'hot',
    workspace: 'optional',
    handle: (ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          abortedReason = ctx.signal.reason?.message;
          resolve({ ok: true, body: 'late' });
        });
      }),
  };
  await withDaemon({ ops: [wait], limits: { budgetMs: { hot: 200, background: 400 } } }, async ({ home }) => {
    const res = await sidecarRequest({ home, op: 'test.wait', scope: 'hook', budget: 'hot', timeoutMs: 3000 });
    // DEADLINE is the sidecar's own answer at its 200 ms budget; had it kept waiting, the client
    // would have answered TIMEOUT at 3 s. No wall-clock bound, which a loaded host can stretch.
    assert.equal(res.reasonCode, 'DEADLINE');
    assert.equal(abortedReason, 'DEADLINE');
    // An event received long ago has no budget left: refused at once, the handler never runs.
    abortedReason = undefined;
    const old = await sidecarRequest({ home, op: 'test.wait', scope: 'hook', budget: 'hot', eventAtMs: Date.now() - 5000 });
    assert.equal(old.reasonCode, 'DEADLINE');
    assert.equal(abortedReason, undefined);
  });
});

test('the op loader refuses two packages exporting one op name, naming both', async () => {
  const def = (op) => ({ op, scope: 'status', budget: 'hot', handle: () => ({ ok: true, body: null }) });
  await assert.rejects(
    loadOps({ sources: [{ name: '@jevris/core', ops: [def('plan')], subscribers: [] }, { name: '@jevris/orchestrator', ops: [def('plan')], subscribers: [] }] }),
    (error) => error instanceof DuplicateOpError && error.message.includes('@jevris/core') && error.message.includes('@jevris/orchestrator'),
  );
  await assert.rejects(loadOps({ sources: [{ name: '@jevris/evals', ops: [def('status')], subscribers: [] }] }), /@jevris\/sidecar \(built-in\)/);
  const home = tempHome();
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, ops: [def('ping')] });
  assert.equal(started.ok, false);
  assert.equal(started.reason, 'duplicate-op');
  assert.equal(existsSync(runtimeFiles({ home }).lock), false);
  rmSync(home, { recursive: true, force: true });
});

for (const store of [true, false]) {
  test(`a repeated delivery key is a duplicate only inside the dedup window, ${store ? 'in the store' : 'in memory without a store'} (DATA-02, HKR-02)`, { skip: managedHostSkip() }, async () => {
    const { EVENT_DEDUP_WINDOW_MS } = await import('../dist/state.js');
    let nowMs = 1_000_000;
    let ran = 0;
    const subscribers = [{ name: 'count', handle: () => ({ n: (ran += 1) }) }];
    await withDaemon({ store, subscribers, eventClock: () => nowMs }, async ({ home }) => {
      const root = join(home, 'ws');
      mkdirSync(root);
      const send = () => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'compact-1', envelope: { kind: 'PreCompact' } } });
      assert.equal((await send()).result.recorded, true);
      nowMs += EVENT_DEDUP_WINDOW_MS - 1;
      assert.equal((await send()).result.duplicate, true, 'a retry inside the window is a redelivery');
      nowMs += 1;
      const later = await send();
      assert.equal(later.result.recorded, true, 'the same key after the window is a new event');
      assert.equal(ran, 2, 'the subscribers ran for each new event and not for the redelivery');
      assert.equal((await send()).result.duplicate, true);
    });
  });
}

test('workspaces and events persist in the store across a restart; a moved-away id is refused (IPC-09, DATA-02)', async () => {
  const home = tempHome();
  const root = join(home, 'repo');
  mkdirSync(root);
  const other = join(home, 'other');
  mkdirSync(other);
  try {
    const first = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
    assert.equal(first.ok, true);
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    const otherId = (await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: other })).result.id;
    const event = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'persist-1', envelope: { kind: 'PreToolUse' } } });
    assert.equal(event.result.recorded, true);
    await first.daemon.stop('test');

    const second = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
    assert.equal(second.ok, true);
    try {
      // The id is known after the restart without re-registering the path.
      const byId = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: registered.result.id });
      assert.equal(byId.ok, true, JSON.stringify(byId));
      assert.deepEqual(byId.result, registered.result);
      // The delivery key was stored durably: a redelivery after restart is a duplicate.
      const dup = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'persist-1', envelope: { kind: 'PreToolUse' } } });
      assert.equal(dup.result.duplicate, true);
      // A persisted id whose root is gone (or is now another directory) is refused.
      rmSync(other, { recursive: true });
      mkdirSync(other);
      const stale = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: otherId });
      assert.equal(stale.ok, false);
    } finally {
      await second.daemon.stop('test');
    }
    const { openStore, closeStore, workspaceView, countEvents, listWorkspaces } = await import('@jevris/store');
    const { hostScopeId } = await import('../dist/state.js');
    const opened = openStore({ path: join(jevrisPaths({ home }).data, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: hostScopeId(home) });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    try {
      assert.equal(listWorkspaces(opened).some((row) => row.workspaceId === registered.result.id), true);
      assert.equal(countEvents(workspaceView(opened, registered.result.id)), 1);
    } finally {
      closeStore(opened);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a subscriber that needs more than 250 ms is still waited on inside the hot budget, so its proposal is not lost under load', { skip: managedHostSkip() }, async () => {
  const subscribers = [
    { name: 'restore', handle: () => new Promise((resolve) => setTimeout(() => resolve({ hookOutcome: { kind: 'context', text: 'restored' } }), 400)) },
    { name: 'security', handle: () => null },
  ];
  await withDaemon({ subscribers }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const res = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'evt-slow-1', envelope: { kind: 'session.started' } } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.result.results.restore, { hookOutcome: { kind: 'context', text: 'restored' } });
    assert.equal(res.result.queued, undefined);
  });
});

test('event appends once per delivery key; a slow subscriber is queued and a throwing one is recorded', { skip: managedHostSkip() }, async () => {
  const finished = [];
  const subscribers = [
    { name: 'fast', handle: () => ({ advice: 'ok' }) },
    { name: 'slow', handle: () => new Promise((resolve) => setTimeout(() => (finished.push('slow'), resolve('done')), 400)) },
    { name: 'broken', handle: () => { throw new Error('boom'); } },
  ];
  await withDaemon({ subscribers, limits: { budgetMs: { hot: 300, background: 5000 } } }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const res = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'evt-1', envelope: { kind: 'PreToolUse' } } });
    assert.equal(res.ok, true, JSON.stringify(res));
    // The append answered before the slow subscriber finished: it was not waited on.
    assert.deepEqual(finished, []);
    assert.equal(res.result.recorded, true);
    assert.deepEqual(res.result.results.fast, { advice: 'ok' });
    assert.deepEqual(res.result.results.slow, { queued: true });
    assert.deepEqual(res.result.queued, ['slow'], 'the answer names the subscribers it did not wait for');
    assert.deepEqual(res.result.results.broken, { error: 'SUBSCRIBER_FAILED' });
    const dup = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'evt-1', envelope: { kind: 'PreToolUse' } } });
    assert.equal(dup.result.duplicate, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(finished, ['slow']);
  });
});

test("D's answer replay, rule 1: a retry inside the window gets the first answer unchanged, marked replayed, and no subscriber runs again; a different body under the key is refused; with the kill switch stopped nothing is replayed", { skip: managedHostSkip() }, async () => {
  let ran = 0;
  const subscribers = [{ name: 'advisor', handle: () => ({ hookOutcome: { kind: 'explain', text: `advice ${String((ran += 1))}` } }) }];
  await withDaemon({ subscribers }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const send = (envelope = { kind: 'PreToolUse' }) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'replay-1', envelope } });
    const first = await send();
    assert.equal(first.result.recorded, true, JSON.stringify(first));
    const retry = await send();
    assert.deepEqual(retry.result, { ...first.result, recorded: false, duplicate: true, replayed: true });
    assert.equal(ran, 1, 'the retry ran no subscriber, so no effect is repeated');
    // The same key with another event is not a retry of this one: refused, with its code.
    const other = await send({ kind: 'PreToolUse', toolName: 'Bash' });
    assert.equal(other.ok, false, JSON.stringify(other));
    assert.equal(other.reasonCode, 'DELIVERY_BODY_MISMATCH');
    // With the kill switch stopped, the retry gets the duplicate answer, not the advice.
    const flag = join(jevrisPaths({ home }).config, 'kill-switch.json');
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(flag, '{"stopped":true}\n');
    assert.deepEqual((await send()).result, { recorded: false, duplicate: true, results: {} });
    writeFileSync(flag, '{"stopped":false}\n');
    assert.equal((await send()).result.replayed, true, 'paired: cleared, the retry is replayed again');
    assert.equal(ran, 1);
  });
});

test("D's answer replay, rule 2: a retry while the first is in flight waits for its answer and gets it; a retry whose own deadline comes first gets the duplicate answer in time", { skip: managedHostSkip() }, async () => {
  let ran = 0;
  let release = () => undefined;
  let clockCalls = 0;
  let releaseAtCall = Number.POSITIVE_INFINITY;
  const subscribers = [
    {
      name: 'advisor',
      handle: () =>
        new Promise((resolve) => {
          ran += 1;
          release = () => resolve({ hookOutcome: { kind: 'explain', text: 'held advice' } });
        }),
    },
  ];
  // The retry reads the clock twice (its record, then its replay lookup): release the first then,
  // so the retry is already waiting on the first when it answers.
  const eventClock = () => {
    clockCalls += 1;
    if (clockCalls === releaseAtCall) setImmediate(() => release());
    return Date.now();
  };
  await withDaemon({ subscribers, eventClock }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const send = (key, extra = {}) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: key, envelope: { kind: 'PreToolUse' } }, ...extra });
    const firstP = send('inflight-1');
    while (ran === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    releaseAtCall = clockCalls + 2;
    const retry = await send('inflight-1');
    const first = await firstP;
    assert.deepEqual(first.result.results, { advisor: { hookOutcome: { kind: 'explain', text: 'held advice' } } }, JSON.stringify(first));
    assert.deepEqual(retry.result, { ...first.result, recorded: false, duplicate: true, replayed: true });
    assert.equal(ran, 1);

    // Paired: the first is held past the retry's own deadline (the retry's event is 750 ms old
    // against the 900 ms hot budget). The retry answers the duplicate, not DEADLINE, while the
    // first is still running: its wait never extends its deadline.
    releaseAtCall = Number.POSITIVE_INFINITY;
    let firstDone = false;
    const slowP = send('inflight-2').then((r) => ((firstDone = true), r));
    while (ran === 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const late = await send('inflight-2', { eventAtMs: Date.now() - 750 });
    assert.equal(late.ok, true, JSON.stringify(late));
    assert.deepEqual(late.result, { recorded: false, duplicate: true, results: {} });
    assert.equal(firstDone, false, 'the retry answered before the first');
    release();
    await slowP;
  });
});

test("D's answer replay, rule 3: a Stop reminder under repeated DEADLINE is never spent and never replayed; the first delivered in time is spent once and its retry replays it", { skip: managedHostSkip() }, async () => {
  let calls = 0;
  let spent = 0;
  let overrun = true;
  const subscribers = [
    {
      name: 'completion',
      handle: async (ctx) => {
        calls += 1;
        // Synchronous work past the whole budget: the request answers DEADLINE.
        if (overrun) for (const until = Date.now() + 300; Date.now() < until; );
        await new Promise((resolve) => setTimeout(resolve, 5));
        // US14: the reminder is spent only while its answer is still wanted.
        if (ctx.signal.aborted) return null;
        spent += 1;
        return { hookOutcome: { kind: 'explain', text: 'Missing verification evidence: unit.' }, reasonCode: 'STOP_REMINDER' };
      },
    },
  ];
  await withDaemon({ subscribers, limits: { budgetMs: { hot: 200, background: 5000 } } }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const stop = (key) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: key, envelope: { kind: 'turn.stopped' } } });
    for (const key of ['stop-1', 'stop-2']) {
      const first = await stop(key);
      assert.equal(first.reasonCode, 'DEADLINE', JSON.stringify(first));
      // Rule 3: the aborted first gives its retry the duplicate answer (observe), nothing replayed.
      const retry = await stop(key);
      assert.deepEqual(retry.result, { recorded: false, duplicate: true, results: {} }, JSON.stringify(retry));
    }
    assert.deepEqual([calls, spent], [2, 0], 'no reminder was spent on an answer nobody saw');
    overrun = false;
    const shown = await stop('stop-3');
    assert.deepEqual(shown.result.results.completion, { hookOutcome: { kind: 'explain', text: 'Missing verification evidence: unit.' }, reasonCode: 'STOP_REMINDER' }, JSON.stringify(shown));
    const again = await stop('stop-3');
    assert.deepEqual(again.result, { ...shown.result, recorded: false, duplicate: true, replayed: true });
    assert.deepEqual([calls, spent], [3, 1], 'spent once; the retry replayed it');
  });
});

test("D's answer replay cache: per workspace and key, capped in count and bytes, expires with the window, keeps no answer too large, and a dropped in-flight entry answers its waiter with nothing", async () => {
  const { createEventReplay } = await import('../dist/event-replay.js');
  let nowMs = 1_000;
  const replay = createEventReplay({ windowMs: 100, clock: () => nowMs, maxEntries: 2, maxBytes: 64, maxAnswerBytes: 40 });
  replay.begin('w1', 'a', 'h')({ results: { x: 1 } });
  assert.deepEqual(replay.lookup('w1', 'a', 'h'), { state: 'delivered', answer: { results: { x: 1 } } });
  assert.deepEqual(replay.lookup('w2', 'a', 'h'), { state: 'none' }, 'another workspace does not see it');
  assert.deepEqual(replay.lookup('w1', 'a', 'other'), { state: 'body-mismatch' });
  replay.begin('w1', 'big', 'h')({ results: { text: 'x'.repeat(64) } });
  assert.deepEqual(replay.lookup('w1', 'big', 'h'), { state: 'aborted' }, 'too large to keep: the duplicate answer');
  replay.begin('w1', 'gone', 'h')(null);
  assert.deepEqual(replay.lookup('w1', 'gone', 'h'), { state: 'aborted' });
  assert.equal(replay.size().entries, 2, 'the count cap dropped the oldest');
  assert.deepEqual(replay.lookup('w1', 'a', 'h'), { state: 'none' });
  // An in-flight entry the cap drops answers a waiting retry with nothing (rule 3).
  replay.begin('w1', 'p', 'h');
  const pending = replay.lookup('w1', 'p', 'h');
  assert.equal(pending.state, 'pending');
  replay.begin('w1', 'q', 'h');
  replay.begin('w1', 'r', 'h');
  assert.equal(await pending.settled, null);
  // The byte cap: two 38-byte answers exceed 64 bytes, so the older one goes.
  const fill = { r: 'y'.repeat(30) };
  replay.begin('w1', 'b1', 'h')(fill);
  replay.begin('w1', 'b2', 'h')(fill);
  assert.ok(replay.size().bytes <= 64, JSON.stringify(replay.size()));
  assert.deepEqual(replay.lookup('w1', 'b1', 'h'), { state: 'none' });
  assert.equal(replay.lookup('w1', 'b2', 'h').state, 'delivered');
  // Expiry with the window.
  nowMs += 100;
  assert.deepEqual(replay.lookup('w1', 'b2', 'h'), { state: 'none' });
  assert.deepEqual(replay.size(), { entries: 0, bytes: 0 });
});

test('two racing starts produce one sidecar, and a stale socket and pidfile are recovered (IPC-12)', async () => {
  const home = tempHome();
  try {
    const [a, b] = await Promise.all([
      startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined }),
      startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined }),
    ]);
    try {
      assert.equal([a, b].filter((r) => r.ok).length, 1);
      const loser = a.ok ? b : a;
      assert.equal(loser.reason, 'already-running');
    } finally {
      for (const r of [a, b]) if (r.ok) await r.daemon.stop('test');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('SIGKILL then restart comes up healthy (IPC-12)', { skip: !posix && 'SIGKILL leaves no socket file on Windows pipes' }, async () => {
  const home = tempHome();
  const child = spawnSidecar(home);
  try {
    const files = runtimeFiles({ home });
    const endpoint = await endpointOf(files);
    assert.ok(endpoint, 'child wrote its endpoint');
    child.kill('SIGKILL');
    assert.notEqual(await exitOf(child, 10_000), null, 'the killed child exited');
    assert.equal(existsSync(endpoint.endpoint), true, 'the killed sidecar left its socket');
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
    assert.equal(started.ok, true, started.ok ? '' : started.message);
    const res = await sidecarRequest({ home, op: 'health', scope: 'cli' });
    assert.equal(res.ok, true);
    assert.equal(res.result.pid, process.pid);
    await started.daemon.stop('test');
  } finally {
    await endChild(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('a home path too long for a Unix socket uses the private short-socket fallback (IPC-08)', { skip: !posix && 'named pipes have no path limit' }, async () => {
  const base = tempHome('jvl');
  const home = join(base, 'a'.repeat(60), 'b'.repeat(40));
  mkdirSync(home, { recursive: true });
  let fallbackSocket;
  try {
    await withDaemon({ home }, async ({ daemon }) => {
      const files = runtimeFiles({ home });
      fallbackSocket = daemon.endpoint.endpoint;
      assert.ok(Buffer.byteLength(files.preferredSocket) > 103);
      assert.notEqual(daemon.endpoint.endpoint, files.preferredSocket);
      assert.ok(Buffer.byteLength(daemon.endpoint.endpoint) <= 103);
      assert.equal(statSync(dirname(daemon.endpoint.endpoint)).mode & 0o077, 0);
      const res = await sidecarRequest({ home, op: 'ping', scope: 'hook' });
      assert.equal(res.ok, true);
    });
    // A clean stop removes its socket from the shared fallback directory. The directory
    // itself (owner-only, shared by every home of this user) is kept.
    assert.equal(existsSync(fallbackSocket), false, 'the fallback socket is removed on stop');
    assert.equal(statSync(dirname(fallbackSocket)).isDirectory(), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a stop that arrives while the sidecar is still starting stops it, rather than leaving it to come up (IPC-16, US05)', { skip: !posix }, async () => {
  const home = tempHome();
  const previous = process.env.JEVRIS_SIDECAR_ENTRY;
  process.env.JEVRIS_SIDECAR_ENTRY = MAIN;
  try {
    // A hook's start: it spawns and returns at once, before the sidecar has an endpoint.
    const hook = await ensureSidecar({ home, waitMs: 0 });
    assert.equal(hook.reason, 'starting');
    const stopped = await stopSidecarProcess(home, 8000);
    assert.equal(stopped.stopped, true, JSON.stringify(stopped));
    assert.notEqual(stopped.method, 'not-running', 'the starting sidecar was found and stopped');
    // It stays stopped: nothing comes up afterwards.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probe = await probeSidecar(home);
    assert.equal(probe.running, false);
  } finally {
    if (previous === undefined) delete process.env.JEVRIS_SIDECAR_ENTRY;
    else process.env.JEVRIS_SIDECAR_ENTRY = previous;
    await stopSidecarProcess(home).catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test('a newer client makes an older sidecar drain and exit (IPC-14)', async () => {
  const home = tempHome();
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true);
  const files = runtimeFiles({ home });
  const socket = net.connect(protocol.readEndpoint(files).endpoint);
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(`${JSON.stringify({ t: 'hello', v: 1, client: 'hook', cnonce: protocol.newNonce(), runtimeVersion: '999.0.0' })}\n`);
  const text = await new Promise((resolve) => {
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString('utf8')));
    socket.on('close', () => resolve(data));
  });
  assert.match(text, /VERSION_MISMATCH/);
  assert.equal(await started.daemon.stopped, 'version-skew');
  assert.equal(existsSync(files.endpoint), false);
  rmSync(home, { recursive: true, force: true });
});

test('the sidecar exits after its idle period (IPC-14)', async () => {
  const home = tempHome();
  const started = await startDaemon({ home, packageOps: false, idleMs: 150, log: () => undefined });
  assert.equal(started.ok, true);
  assert.equal(await started.daemon.stopped, 'idle');
  assert.equal(existsSync(runtimeFiles({ home }).lock), false);
  rmSync(home, { recursive: true, force: true });
});

test('a verification run in progress holds off the idle exit, and the idle period starts when it ends (IPC-14, D 21e3481)', async () => {
  const home = tempHome();
  let running = 1;
  const started = await startDaemon({ home, packageOps: false, idleMs: 150, backgroundWork: () => running, log: () => undefined });
  assert.equal(started.ok, true);
  try {
    const early = await Promise.race([started.daemon.stopped, new Promise((resolve) => setTimeout(() => resolve('still running'), 700))]);
    assert.equal(early, 'still running', 'no idle exit while a verification run is active');
    running = 0;
    const releasedAt = Date.now();
    assert.equal(await started.daemon.stopped, 'idle');
    assert.ok(Date.now() - releasedAt >= 100, 'the idle period counts from the end of the run');
  } finally {
    await started.daemon.stop('test').catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test('the default idle check counts the orchestrator\'s verification runs (IPC-14)', async () => {
  const { activeVerificationRuns } = await import('@jevris/orchestrator');
  assert.equal(activeVerificationRuns(), 0);
  const home = tempHome();
  const started = await startDaemon({ home, packageOps: false, idleMs: 150, log: () => undefined });
  assert.equal(started.ok, true);
  assert.equal(await started.daemon.stopped, 'idle', 'with no run the idle exit still happens');
  rmSync(home, { recursive: true, force: true });
});

test('the entry point hands the launching umask it replaced with 077 to the orchestrator (D 21e3481)', async () => {
  const { applyPrivateUmask } = await import('../dist/main.js');
  const { checkUmask, DEFAULT_CHECK_UMASK } = await import('@jevris/orchestrator');
  const set = [];
  const recorded = [];
  assert.equal(applyPrivateUmask({ platform: 'linux', umask: (mask) => (set.push(mask), 0o027), record: (mask) => recorded.push(mask) }), 0o027);
  assert.deepEqual(set, [0o077]);
  assert.deepEqual(recorded, [0o027]);
  assert.equal(applyPrivateUmask({ platform: 'win32', umask: () => assert.fail('no umask on Windows'), record: () => assert.fail('nothing to record') }), null);
  // The default recorder is the orchestrator's: checks then run under the launching mask.
  assert.equal(typeof DEFAULT_CHECK_UMASK, 'number');
  applyPrivateUmask({ platform: 'linux', umask: () => 0o027 });
  assert.equal(checkUmask(), 0o027);
});

test('a spawn lock left by a dead spawner does not hold back the next start (IPC-12, OBS-05 interrupted update)', async () => {
  const home = tempHome();
  const previous = process.env.JEVRIS_SIDECAR_ENTRY;
  process.env.JEVRIS_SIDECAR_ENTRY = MAIN;
  try {
    const files = runtimeFiles({ home });
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    const gone = Number(spawnSyncChild(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    // Fresh by its time stamp, so only the dead pid can make it stale.
    writeFileSync(files.spawnLock, JSON.stringify({ pid: gone, atMs: Date.now() }), { mode: 0o600 });
    const started = await ensureSidecar({ home, waitMs: 8000 });
    assert.equal(started.ok, true, JSON.stringify(started));
  } finally {
    if (previous === undefined) delete process.env.JEVRIS_SIDECAR_ENTRY;
    else process.env.JEVRIS_SIDECAR_ENTRY = previous;
    await stopSidecarProcess(home).catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test('ten parallel callers start one sidecar; a hook never waits; stop uses the shutdown frame (IPC-13, IPC-16)', async () => {
  const home = tempHome();
  const previous = process.env.JEVRIS_SIDECAR_ENTRY;
  process.env.JEVRIS_SIDECAR_ENTRY = MAIN;
  try {
    const hook = await ensureSidecar({ home, waitMs: 0 });
    // 'starting' (not ok) proves the hook returned before the sidecar was up: it never waits.
    assert.equal(hook.ok, false);
    assert.equal(hook.reason, 'starting');
    const results = await Promise.all(Array.from({ length: 10 }, () => ensureSidecar({ home, waitMs: 8000 })));
    for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
    const probe = await probeSidecar(home);
    assert.equal(probe.running, true);
    const pid = probe.endpoint.pid;
    assert.notEqual(pid, process.pid);
    // One daemon: every caller sees the same endpoint and pid.
    assert.equal(new Set(results.map((r) => r.endpoint)).size, 1);
    const status = await sidecarRequest({ home, op: 'status', scope: 'mcp' });
    assert.equal(status.ok, true);
    const stopped = await stopSidecarProcess(home);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.method, 'shutdown-frame');
    assert.equal(protocol.pidAlive(pid), false);
    const after = await sidecarRequest({ home, op: 'ping', scope: 'cli' });
    assert.equal(after.ok, false);
    assert.equal(after.reason, 'unavailable');
  } finally {
    if (previous === undefined) delete process.env.JEVRIS_SIDECAR_ENTRY;
    else process.env.JEVRIS_SIDECAR_ENTRY = previous;
    await stopSidecarProcess(home).catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test('SIGTERM drains and removes the socket, pidfile and keys (IPC-11)', { skip: !posix && 'POSIX signal delivery' }, async () => {
  const home = tempHome();
  const child = spawnSidecar(home);
  try {
    const files = runtimeFiles({ home });
    const endpoint = await endpointOf(files);
    assert.ok(endpoint, 'child wrote its endpoint');
    child.kill('SIGTERM');
    const exited = await exitOf(child, 15_000);
    assert.notEqual(exited, null, 'the SIGTERM drain finished');
    assert.deepEqual(exited, [0, null]);
    for (const path of [files.endpoint, files.pid, files.key('cli'), endpoint.endpoint, files.lock]) {
      assert.equal(existsSync(path), false, `${path} removed`);
    }
    const log = readFileSync(join(jevrisPaths({ home }).state, 'logs', 'sidecar.log'), 'utf8');
    assert.match(log, /"event":"stopped"/);
    assert.match(log, /SIGTERM/);
  } finally {
    await endChild(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('a SIGTERM that arrives while the sidecar is still starting is latched and drains it (IPC-11)', { skip: !posix && 'POSIX signal delivery' }, async () => {
  const home = tempHome();
  const child = spawnSidecar(home);
  try {
    const files = runtimeFiles({ home });
    // The pidfile is written before the endpoint: signal in that window.
    for (let i = 0; i < 6000 && !existsSync(files.pid); i += 1) await new Promise((r) => setTimeout(r, 5));
    child.kill('SIGTERM');
    const exited = await exitOf(child, 15_000);
    assert.notEqual(exited, null, 'the latched SIGTERM drained the sidecar');
    const [code, signal] = exited;
    assert.equal(signal, null, 'not killed by the default SIGTERM action');
    assert.equal(code, 0);
    for (const path of [files.endpoint, files.pid, files.key('cli'), files.lock]) assert.equal(existsSync(path), false, `${path} removed`);
  } finally {
    await endChild(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('the Windows pipe name is random and per user, and the pipe ACL step keeps only the user and SYSTEM (IPC-05)', async () => {
  const { pipeAclScript, pipeAclOwnerOnly, hardenPipeAcl } = await import('../dist/daemon.js');
  const a = protocol.randomPipeName('S-1-5-21-1-2-3-1001');
  const b = protocol.randomPipeName('S-1-5-21-1-2-3-1001');
  assert.match(a, /^\\\\\.\\pipe\\jevris-[0-9a-f]{12}-[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(a.slice(0, 29), b.slice(0, 29));
  assert.notEqual(protocol.randomPipeName('S-1-5-21-9').slice(0, 29), a.slice(0, 29));
  const script = pipeAclScript(a);
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /S-1-5-18/);
  assert.equal(pipeAclOwnerOnly('ME=S-1-5-21-1\nACE=S-1-5-21-1\nACE=S-1-5-18\n'), true);
  assert.equal(pipeAclOwnerOnly('ME=S-1-5-21-1\nACE=S-1-5-21-1\nACE=S-1-1-0\n'), false);
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, args[0]]);
    return { status: 0, stdout: 'ME=S-1-5-21-1\r\nACE=S-1-5-21-1\r\nACE=S-1-5-18\r\n' };
  };
  assert.equal(hardenPipeAcl(a, exec), true);
  assert.match(calls[0][0], /powershell\.exe$/);
  assert.equal(hardenPipeAcl(a, () => ({ status: 1, stdout: '' })), false);
});

// IPC-05 on a real Windows host (the windows-latest CI cell): the live pipe, not a script check.
if (process.platform === 'win32') {
  test('on Windows the live sidecar pipe is random, answers only a keyed client, and its DACL is the user and SYSTEM only (IPC-05)', async () => {
    await withDaemon({}, async ({ home, daemon }) => {
      const until = Date.now() + 30_000;
      while (daemon.pipeAcl === 'pending' && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(daemon.pipeAcl, 'owner-only', 'the pipe DACL was not reduced to the user and SYSTEM');
      assert.match(daemon.endpoint.endpoint, /^\\\\\.\\pipe\\jevris-[0-9a-f]{12}-[0-9a-f]{32}$/);
      const res = await sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} });
      assert.equal(res.ok, true, JSON.stringify(res));
      // The endpoint file is owner-checked: the client reads it back and it names this pipe.
      assert.equal(protocol.readEndpoint(runtimeFiles({ home })).endpoint, daemon.endpoint.endpoint);
    });
  });
}

test('the status body validates against the surface StatusPayload contract, with and without a workspace', async () => {
  const { surfacePayloadContract } = await import('@jevris/contracts');
  await withDaemon({}, async ({ home }) => {
    const root = join(home, 'repo');
    mkdirSync(root);
    for (const workspace of [undefined, root]) {
      const res = await sidecarRequest({ home, op: 'status', scope: 'mcp', body: {}, ...(workspace ? { workspace } : {}) });
      assert.equal(res.ok, true, JSON.stringify(res));
      const checked = surfacePayloadContract('status').validate(res.result);
      assert.equal(checked.ok, true, JSON.stringify(checked));
    }
  });
});

test('status carries the workspace\'s last unverified stop report until its checks pass (VER-05)', async () => {
  const { surfacePayloadContract } = await import('@jevris/contracts');
  const { openWorkspace } = await import('@jevris/orchestrator');
  await withDaemon({}, async ({ home }) => {
    const root = join(home, 'repo');
    mkdirSync(root);
    let res = await sidecarRequest({ home, op: 'status', scope: 'mcp', body: {}, workspace: root });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.stopReport, null, 'no stop report yet');
    // The row D's stop decision writes when work ends without current passing receipts.
    const ws = openWorkspace({ home, workspaceRoot: root });
    const text = 'Unverified: the work ends without current passing receipts for unit. Uncovered requirements: R1. It is labelled unverified.';
    await ws.state.transact((tx) => tx.put('stop-reports', `${ws.workspaceId}/-`, {
      workspaceId: ws.workspaceId, taskId: null, at: '2026-09-26T09:00:00.000Z', outcome: 'unverified', continuationScheduled: false, remindersFired: 1,
      missingEvidence: ['unit:missing'], uncoveredRequirements: ['R1'], text, humanStopAvailable: true,
    }));
    res = await sidecarRequest({ home, op: 'status', scope: 'mcp', body: {}, workspace: root });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.result.stopReport, { outcome: 'unverified', text, at: '2026-09-26T09:00:00.000Z', missingEvidence: ['unit'], uncoveredRequirements: ['R1'] });
    assert.equal(surfacePayloadContract('status').validate(res.result).ok, true);
    // The global workspace has none.
    res = await sidecarRequest({ home, op: 'status', scope: 'mcp', body: {} });
    assert.equal(res.result.stopReport, null);
  });
});

test('status carries the workspace\'s Stop reminder counts when the contract has the field, and a valid body when it does not (P6)', async () => {
  const { surfacePayloadContract } = await import('@jevris/contracts');
  const { openWorkspace } = await import('@jevris/orchestrator');
  await withDaemon({}, async ({ home }) => {
    const root = join(home, 'repo');
    mkdirSync(root);
    const contract = surfacePayloadContract('status');
    const status = async (workspace) => {
      const res = await sidecarRequest({ home, op: 'status', scope: 'mcp', body: {}, ...(workspace ? { workspace } : {}) });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(contract.validate(res.result).ok, true, 'the body always fits the surface contract');
      return res.result;
    };
    const zero = { fired: 0, ledToCheck: 0, ledToVerification: 0, endedUnverified: 0 };
    let body = await status(root);
    // E adds `reminders` to StatusPayload; until then the sidecar sends the body without it.
    const hasField = contract.validate({ ...body, reminders: zero }).ok;
    assert.equal('reminders' in body, hasField);
    if (hasField) assert.deepEqual(body.reminders, zero);
    // Two reminders in this workspace (one led to a check and a verified stop, one ended unverified)
    // and one in another workspace, which does not count here.
    const ws = openWorkspace({ home, workspaceRoot: root });
    await ws.state.transact((tx) => {
      tx.put('stop-reminders', `${ws.workspaceId}/T1`, {
        key: `${ws.workspaceId}/T1`, fired: 2, firedAtMs: 2_000, outcome: 'ended-unverified', timeToOutcomeMs: 500, timeToCheckMs: null,
        history: [{ firedAtMs: 1_000, outcome: 'verified', timeToOutcomeMs: 900, timeToCheckMs: 300 }],
      });
      tx.put('stop-reminders', 'ws-other/T1', { key: 'ws-other/T1', fired: 1, firedAtMs: 1_000, outcome: null, timeToOutcomeMs: null, timeToCheckMs: null });
    });
    body = await status(root);
    assert.equal('reminders' in body, hasField);
    if (hasField) assert.deepEqual(body.reminders, { fired: 2, ledToCheck: 1, ledToVerification: 1, endedUnverified: 1 });
    // The global workspace has no workspace state: null.
    body = await status(undefined);
    assert.equal('reminders' in body, hasField);
    if (hasField) assert.equal(body.reminders, null);
  });
});

test('status reports native sessions outside Jevris ownership as an advisory estimate, never a hard cap (W09)', async () => {
  const { surfacePayloadContract } = await import('@jevris/contracts');
  await withDaemon({}, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const status = async (workspace) => (await sidecarRequest({ home, op: 'status', scope: 'mcp', body: {}, ...(workspace ? { workspace } : {}) })).result;
    let body = await status(root);
    assert.deepEqual(body.nativeSpend, { sessions: 0, estimateMicroUsd: null, coverage: 'advisory-estimate' });
    const envelope = (sessionId) => ({ schemaVersion: '1.0', harness: 'claude', nativeEventName: 'session.started', kind: 'session.started', sessionId, model: 'claude-opus-4-7', payload: {}, dedupKey: `start-${sessionId}` });
    for (const id of ['native-1', 'native-2']) {
      const sent = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: `k-${id}`, envelope: envelope(id) } });
      assert.equal(sent.ok, true, JSON.stringify(sent));
    }
    body = await status(root);
    // Two native sessions; hooks report no usage, so the estimate is unknown, and it is labelled
    // advisory: the owned budget's hard cap never covers them.
    assert.deepEqual(body.nativeSpend, { sessions: 2, estimateMicroUsd: null, coverage: 'advisory-estimate' });
    assert.equal(surfacePayloadContract('status').validate(body).ok, true);
    assert.equal((await status()).nativeSpend.sessions, 2, 'the host view counts every workspace');
  });
});

test("C's decision subscriber is built with D's host-ledger harness version source", async () => {
  const { harnessVersionSource, withHarnessVersions } = await import('../dist/ops.js');
  const seen = [];
  const versionOf = harnessVersionSource((home, harness) => (seen.push([home, harness]), harness === 'claude' ? '2.1.0' : null));
  assert.equal(versionOf('/h', 'claude'), '2.1.0');
  assert.equal(versionOf('/h', '../etc'), null, 'a harness outside HARNESS_IDS never reaches the ledger');
  assert.deepEqual(seen, [['/h', 'claude']]);
  assert.equal(harnessVersionSource(() => { throw new Error('ledger'); })('/h', 'codex'), null);
  // The default source is D's host-ledger harnessVersionOf: an empty home has no version.
  const home = tempHome();
  try {
    assert.equal(harnessVersionSource()(home, 'claude'), null);
    const { recordHarnessVersion } = await import('@jevris/orchestrator');
    await recordHarnessVersion(home, 'claude', '2.1.7');
    assert.equal(harnessVersionSource()(home, 'claude'), '2.1.7');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  let options;
  const fake = {
    sidecarOps: [],
    DEFAULT_TRIGGER_HANDLERS: { tool: [] },
    sidecarEventSubscribers: [{ name: 'decision', handle: () => 'default' }, { name: 'other', handle: () => 'other' }],
    createDecisionSubscriber: (o) => ((options = o), { name: 'decision', handle: () => 'rebuilt' }),
  };
  const wired = withHarnessVersions(fake, versionOf);
  assert.equal(options.harnessVersionOf, versionOf);
  assert.deepEqual(options.handlers, fake.DEFAULT_TRIGGER_HANDLERS);
  assert.deepEqual(wired.sidecarEventSubscribers.map((s) => s.handle()), ['rebuilt', 'other']);
  assert.equal(withHarnessVersions(fake, undefined), fake);

  // With the real package, the rebuilt subscriber keeps the exported name.
  const provider = await import('@jevris/provider-typesafe');
  const real = withHarnessVersions(provider, versionOf);
  assert.deepEqual(real.sidecarEventSubscribers.map((s) => s.name), provider.sidecarEventSubscribers.map((s) => s.name));
  assert.notEqual(real.sidecarEventSubscribers[0], provider.sidecarEventSubscribers[0]);
});

test('the kill switch is read on every request, fails closed, and stops a kill-switch op until cleared (GOV-02, GOV-04)', { skip: managedHostSkip() }, async () => {
  let runs = 0;
  const ops = [{ op: 'test.effect', scope: 'submit', budget: 'hot', workspace: 'optional', stoppedByKillSwitch: true, handle: () => ((runs += 1), { ok: true, body: { ran: true } }) }];
  await withDaemon({ ops }, async ({ home }) => {
    const flag = join(jevrisPaths({ home }).config, 'kill-switch.json');
    mkdirSync(dirname(flag), { recursive: true });
    const call = () => sidecarRequest({ home, op: 'test.effect', scope: 'cli', body: {} });
    assert.equal((await call()).ok, true);
    writeFileSync(flag, '{"stopped":true}\n');
    const stopped = await call();
    assert.equal(stopped.ok, false);
    assert.equal(stopped.reasonCode, 'KILL_SWITCH');
    // Corrupt, non-UTF-8 and wrong-shape flags read as stopped (fail closed).
    for (const bad of ['{not json', Buffer.from([0xff, 0xfe, 0x00]), '{"stopped":"no"}', '[]']) {
      writeFileSync(flag, bad);
      assert.equal((await call()).reasonCode, 'KILL_SWITCH');
    }
    const status = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
    assert.equal(status.result.killSwitch, 'stopped');
    writeFileSync(flag, '{"stopped":false}\n');
    assert.equal((await call()).ok, true);
    assert.equal(runs, 2, 'the handler never ran while the switch was stopped');
  });
});

test('an oversize body or frame line is refused OVERSIZE before any handler runs (IPC-04)', async () => {
  let runs = 0;
  const ops = [{ op: 'test.echo', scope: 'status', budget: 'hot', workspace: 'optional', handle: () => ((runs += 1), { ok: true, body: null }) }];
  await withDaemon({ ops }, async ({ home }) => {
    const session = await rawSession(home, 'cli');
    try {
      const big = session.frame('test.echo', { pad: 'x'.repeat(protocol.MAX_BODY_BYTES + 1) });
      const refused = await session.send(big);
      assert.equal(refused.t, 'error');
      assert.equal(refused.reasonCode, 'OVERSIZE');
    } finally {
      session.close();
    }
    const line = await rawSession(home, 'cli');
    try {
      line.socket.write('x'.repeat(protocol.MAX_LINE_BYTES + 10));
      const answer = await line.next();
      assert.equal(answer?.reasonCode, 'OVERSIZE');
    } finally {
      line.close();
    }
    assert.equal(runs, 0);
  });
});

test('a refused store is reported once, in one plain line with the next step, and the sidecar still answers (DATA-10, BLD-13)', async () => {
  const home = tempHome();
  const logs = [];
  try {
    const dataDir = jevrisPaths({ home }).data;
    mkdirSync(dataDir, { recursive: true });
    const { openStore, closeStore } = await import('@jevris/store');
    // A store written under another host scope (copied from another machine or user).
    const foreign = openStore({ path: join(dataDir, 'jevris.db'), role: 'sidecar', workspaceId: 'host', hostScope: 'hforeign000000000000000000' });
    assert.equal(foreign.ok, true, JSON.stringify(foreign));
    closeStore(foreign);
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: (entry) => logs.push(entry) });
    assert.equal(started.ok, true);
    try {
      const health = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
      assert.equal(health.ok, true);
      assert.equal(health.result.store.state, 'unavailable');
      // The file is this user's and in this home: most likely this machine under an earlier
      // network name, so the line names `jevris store adopt` and the move-aside steps (DATA-10).
      assert.match(health.result.store.diagnostic, /another machine identity.*earlier network name of this machine.*`jevris store adopt`/);
      assert.equal(health.result.store.diagnostic.includes('\n'), false);
      await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
      assert.equal(logs.filter((entry) => entry.event === 'store-refused').length, 1);
    } finally {
      await started.daemon.stop('test');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('owned mode grants mcp exactly task.submit for its workspace, read per request; env, other ops, other workspaces and the kill switch are denied (IPC-10, TOOL-10)', { skip: managedHostSkip() }, async () => {
  const { setOwnedMode } = await import('@jevris/orchestrator');
  const ran = [];
  const op = (name, scope, extra = {}) => ({ op: name, scope, budget: 'hot', ...extra, handle: (ctx) => (ran.push(`${name}:${ctx.workspace.id}`), { ok: true, body: { ran: name } }) });
  const ops = [op('task.submit', 'submit', { stoppedByKillSwitch: true }), op('task.cancel', 'submit'), op('test.admin', 'admin', { workspace: 'optional' })];
  const previous = process.env.JEVRIS_OWNED_MODE;
  await withDaemon({ ops }, async ({ home }) => {
    const rootA = join(home, 'a');
    const rootB = join(home, 'b');
    mkdirSync(rootA);
    mkdirSync(rootB);
    const idA = (await sidecarRequest({ home, op: 'workspace.register', scope: 'cli', workspace: rootA })).result.id;
    const idB = (await sidecarRequest({ home, op: 'workspace.register', scope: 'cli', workspace: rootB })).result.id;
    const mcp = (name, workspace) => sidecarRequest({ home, op: name, scope: 'mcp', workspace, body: {} });

    assert.equal((await mcp('task.submit', rootA)).reasonCode, 'SCOPE_DENIED', 'owned mode off');
    process.env.JEVRIS_OWNED_MODE = '1';
    assert.equal((await mcp('task.submit', rootA)).reasonCode, 'SCOPE_DENIED', 'the environment alone grants nothing');

    assert.equal((await setOwnedMode({ home, workspaceId: idA, enabled: true, channel: 'cli' })).ok, true);
    const granted = await mcp('task.submit', rootA);
    assert.equal(granted.ok, true, JSON.stringify(granted));
    assert.equal((await mcp('task.cancel', rootA)).reasonCode, 'SCOPE_DENIED', 'no other submit op');
    assert.equal((await mcp('test.admin', rootA)).reasonCode, 'SCOPE_DENIED', 'never admin');
    assert.equal((await mcp('task.submit', rootB)).reasonCode, 'SCOPE_DENIED', 'another workspace');
    assert.equal((await sidecarRequest({ home, op: 'task.submit', scope: 'mcp', body: {} })).ok, false, 'no workspace, no grant');

    // Revocation reaches an already-connected client at its next request.
    const session = await rawSession(home, 'mcp');
    const outcome = (res) => (res.t === 'error' ? { ok: false, reasonCode: res.reasonCode } : payload(res));
    try {
      const first = outcome(await session.send(session.frame('task.submit', {}, { ws: idA })));
      assert.equal(first.ok, true, JSON.stringify(first));
      await setOwnedMode({ home, workspaceId: idA, enabled: false, channel: 'cli' });
      const second = outcome(await session.send(session.frame('task.submit', {}, { ws: idA })));
      assert.equal(second.ok, false);
      assert.equal(second.reasonCode, 'SCOPE_DENIED');
      await setOwnedMode({ home, workspaceId: idA, enabled: true, channel: 'cli' });
      const flag = join(jevrisPaths({ home }).config, 'kill-switch.json');
      mkdirSync(dirname(flag), { recursive: true });
      writeFileSync(flag, '{"stopped":true}\n');
      const stopped = outcome(await session.send(session.frame('task.submit', {}, { ws: idA })));
      assert.equal(stopped.reasonCode, 'KILL_SWITCH', 'the kill switch revokes the grant');
    } finally {
      session.close();
    }
    assert.deepEqual(ran, [`task.submit:${idA}`, `task.submit:${idA}`]);
    assert.notEqual(idA, idB);
  });
  if (previous === undefined) delete process.env.JEVRIS_OWNED_MODE;
  else process.env.JEVRIS_OWNED_MODE = previous;
});

test('with the kill switch stopped an event is recorded but no subscriber runs (GOV-04)', { skip: managedHostSkip() }, async () => {
  let calls = 0;
  const subscribers = [{ name: 'advisor', handle: () => ((calls += 1), { advice: 'x' }) }];
  await withDaemon({ subscribers }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const flag = join(jevrisPaths({ home }).config, 'kill-switch.json');
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(flag, '{"stopped":true}\n');
    const res = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'ks-1', envelope: { kind: 'PreToolUse' } } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.recorded, true);
    assert.equal(res.result.killSwitch, 'stopped');
    assert.deepEqual(res.result.results, {});
    assert.equal(calls, 0);
    writeFileSync(flag, '{"stopped":false}\n');
    const after = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: 'ks-2', envelope: { kind: 'PreToolUse' } } });
    assert.deepEqual(after.result.results.advisor, { advice: 'x' });
    assert.equal(calls, 1);
  });
});

test('harness events upsert their session (requested and actual model, never erased) and subscriber decisions carry the session id (US12)', { skip: managedHostSkip() }, async () => {
  const store = await import('@jevris/store');
  const decided = [];
  const engine = {
    tag: 'engine',
    async decide(request) {
      decided.push(request);
      return { ok: true, decisionId: `d${decided.length}`, self: this.tag };
    },
  };
  const subscribers = [{ name: 'decider', handle: async (ctx) => ctx.engine.decide({ question: 'q', workspaceId: ctx.workspace.id }) }];
  const ops = [{ op: 'test.session', scope: 'status', budget: 'hot', handle: (ctx) => ({ ok: true, body: store.getSession(ctx.store, ctx.body.sessionId) ?? null }) }];
  const event = (kind, extra = {}) => ({ schemaVersion: '1.0', harness: 'claude', nativeEventName: kind, kind, sessionId: 'sess-12', model: null, payload: {}, dedupKey: `${kind}-${Math.random()}`, ...extra });
  await withDaemon({ engine, subscribers, ops, subscriberSliceMs: 60_000, limits: { budgetMs: { hot: 60_000, background: 60_000 } } }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const send = (key, envelope, extra = {}) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 60_000, body: { deliveryKey: key, envelope, ...extra } });
    const session = async () => (await sidecarRequest({ home, op: 'test.session', scope: 'cli', workspace: root, body: { sessionId: 'sess-12' } })).result;

    const started = await send('e1', event('session.started', { model: 'claude-opus-4-7' }), { harnessVersion: '2.1.3' });
    assert.equal(started.ok, true, JSON.stringify(started));
    let row = await session();
    assert.equal(row.harness, 'claude');
    assert.equal(row.harnessVersion, '2.1.3');
    assert.equal(row.actualModel, 'claude-opus-4-7');
    assert.equal(row.requestedModel, null);
    assert.equal(row.state, 'active');
    // The subscriber's decision was stamped with the event's session id; the engine kept its this.
    assert.equal(decided[0].sessionId, 'sess-12');
    assert.deepEqual(started.result.results.decider, { ok: true, decisionId: 'd1', self: 'engine' });

    // A requested switch names the requested model only; an event without a model erases nothing.
    await send('e2', event('model.change.requested', { model: 'claude-opus-4-7', payload: { toModel: 'claude-sonnet-4-6' } }));
    await send('e3', event('tool.proposed'));
    row = await session();
    assert.equal(row.requestedModel, 'claude-sonnet-4-6');
    assert.equal(row.actualModel, 'claude-opus-4-7');
    assert.equal(row.harnessVersion, '2.1.3');
    await send('e4', event('model.changed', { payload: { fromModel: 'claude-opus-4-7', toModel: 'claude-sonnet-4-6' } }));
    await send('e5', event('session.ended'));
    row = await session();
    assert.equal(row.actualModel, 'claude-sonnet-4-6');
    assert.equal(row.state, 'ended');

    // A decision a subscriber already stamps keeps its own session id; an event without one is not a session.
    await send('e6', { schemaVersion: '1.0', harness: 'claude', kind: 'tool.proposed', sessionId: null, payload: {}, dedupKey: 'x' });
    assert.equal(decided.at(-1).sessionId, undefined);
    assert.equal(decided.length, 6);
  });
});

test('SessionStart with a model, then a decision for that session: explain reports the observed model from the session (US12)', { skip: managedHostSkip() }, async () => {
  const provider = await import('@jevris/provider-typesafe');
  const core = await import('@jevris/core');
  const home = tempHome();
  const engine = core.createDecisionEngine({
    transport: provider.createSdkTransport({ apiKey: 'test-key-not-a-secret', fetch: provider.createMockFetch({ scenario: 'valid' }) }),
    journalDir: join(home, 'decisions'),
    budget: core.DecisionBudget.open(join(home, 'budget.json'), { limitMicroUsd: 1_000_000 }),
  });
  const request = (workspaceId) => {
    const compiled = core.compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: provider.CONFORMANCE_REQUEST.questions, evidenceRequirements: ['e1'], deadlineMs: 2000, fallback: 'rules-only' });
    return {
      spec: compiled.spec, questions: provider.CONFORMANCE_REQUEST.questions, workspaceId, evidenceRevision: 'rev-1', taskId: 'task-1',
      packet: { objective: 'Rename a helper', trustedPolicy: {}, facts: {}, evidence: [{ id: 'e1', text: 'A helper exists.', sourceKind: 'file', priority: 'mandatory' }], missingEvidence: [] },
    };
  };
  const decisions = [];
  const subscribers = [{ name: 'decider', handle: async (ctx) => {
    if (ctx.body.envelope.kind !== 'tool.proposed') return null;
    const outcome = await core.decide(request(ctx.workspace.id), ctx.engine);
    decisions.push(outcome.decisionId);
    return { decisionId: outcome.decisionId };
  } }];
  const explain = provider.sidecarOps.find((def) => def.op === 'explain');
  await withDaemon({ home, engine, subscribers, ops: [explain], subscriberSliceMs: 60_000, limits: { budgetMs: { hot: 60_000, background: 60_000 } } }, async () => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const envelope = (kind, extra) => ({ schemaVersion: '1.0', harness: 'claude', nativeEventName: kind, kind, sessionId: 'sess-obs', model: null, payload: {}, dedupKey: kind, ...extra });
    const send = (key, body) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 60_000, body: { deliveryKey: key, ...body } });
    assert.equal((await send('s1', { envelope: envelope('session.started', { model: 'claude-opus-4-7' }) })).ok, true);
    const proposed = await send('s2', { envelope: envelope('tool.proposed', {}) });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    // The subscriber ran inside the event op (slice and budget raised for the test), so the
    // decision has settled when the hook's answer arrives.
    assert.deepEqual(proposed.result.results.decider, { decisionId: decisions[0] });
    assert.equal(decisions.length, 1);
    const explained = await sidecarRequest({ home, op: 'explain', scope: 'cli', workspace: root, body: { decisionId: decisions[0] } });
    assert.equal(explained.ok, true, JSON.stringify(explained));
    assert.equal(explained.result.trace.models.observed, 'claude-opus-4-7');
    assert.equal(explained.result.trace.models.source, 'session');
  });
});

test('a decision the sidecar settles is in the store at once: the next status lists it without a restart or the periodic archive (DATA-05)', async () => {
  const provider = await import('@jevris/provider-typesafe');
  const core = await import('@jevris/core');
  const home = tempHome();
  const engine = core.createDecisionEngine({
    transport: provider.createSdkTransport({ apiKey: 'test-key-not-a-secret', fetch: provider.createMockFetch({ scenario: 'valid' }) }),
    journalDir: join(home, 'decisions'),
    budget: core.DecisionBudget.open(join(home, 'budget.json'), { limitMicroUsd: 1_000_000 }),
  });
  const compiled = core.compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: provider.CONFORMANCE_REQUEST.questions, evidenceRequirements: ['e1'], deadlineMs: 2000, fallback: 'rules-only' });
  const ops = [{
    op: 'test.decide', scope: 'advice', budget: 'background',
    handle: async (ctx) => {
      const outcome = await core.decide({
        spec: compiled.spec, questions: provider.CONFORMANCE_REQUEST.questions, workspaceId: ctx.workspace.id, evidenceRevision: 'rev-1', taskId: 'task-1',
        packet: { objective: 'Rename a helper', trustedPolicy: {}, facts: {}, evidence: [{ id: 'e1', text: 'A helper exists.', sourceKind: 'file', priority: 'mandatory' }], missingEvidence: [] },
      }, ctx.engine);
      return { ok: true, body: { decisionId: outcome.decisionId } };
    },
  }];
  await withDaemon({ home, engine, ops, limits: { budgetMs: { hot: 60_000, background: 60_000 } } }, async () => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const status = async () => (await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: null })).result;
    assert.deepEqual((await status()).recentDecisions, []);
    const decided = await sidecarRequest({ home, op: 'test.decide', scope: 'cli', workspace: root, timeoutMs: 60_000, body: null });
    assert.equal(decided.ok, true, JSON.stringify(decided));
    const listed = (await status()).recentDecisions;
    assert.equal(listed.length, 1, JSON.stringify(listed));
    assert.equal(listed[0].decisionId, decided.result.decisionId);
    // Idempotent with the catch-up archive: a second mirror of the same decision adds no row.
    await sidecarRequest({ home, op: 'test.decide', scope: 'cli', workspace: root, timeoutMs: 60_000, body: null });
    assert.equal((await status()).recentDecisions.length, 2);
  });
});

// ---------------------------------------------------------------- IPC-15: the client's deadline

test('the sidecar stops waiting when the client does: a short client deadline queues a subscriber the hot budget would have waited on (IPC-15)', { skip: managedHostSkip() }, async () => {
  const subscribers = [
    { name: 'slow', handle: () => new Promise((resolve) => setTimeout(() => resolve({ hookOutcome: { kind: 'context', text: 'late' } }), 600)) },
    { name: 'fast', handle: () => ({ hookOutcome: { kind: 'observe' } }) },
  ];
  await withDaemon({ subscribers, limits: { budgetMs: { hot: 900, background: 5000 } } }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const event = (deliveryKey, timeoutMs) =>
      sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs, budget: 'hot', body: { deliveryKey, envelope: { kind: 'session.started' } } });
    // A client that waits past the hot budget: the 700 ms slice waits the 600 ms subscriber.
    const patient = await event('evt-deadline-1', 1500);
    assert.equal(patient.ok, true, JSON.stringify(patient));
    assert.deepEqual(patient.result.results.slow, { hookOutcome: { kind: 'context', text: 'late' } });
    assert.equal(patient.result.queued, undefined);
    // A client that gives up at 700 ms: the slice follows its deadline, so the answer (with the
    // fast proposal) arrives while the client is still listening, and the slow one is queued.
    const hurried = await event('evt-deadline-2', 700);
    assert.equal(hurried.ok, true, JSON.stringify(hurried));
    assert.deepEqual(hurried.result.results.fast, { hookOutcome: { kind: 'observe' } });
    assert.deepEqual(hurried.result.results.slow, { queued: true });
    assert.deepEqual(hurried.result.queued, ['slow']);
  });
});

test('a subscriber\'s signal aborts when its slice ends, so it can leave a consuming effect for the next event; an answered subscriber\'s signal is live (D, US14; pair)', { skip: managedHostSkip() }, async () => {
  const seen = { fast: null, slow: [] };
  const subscribers = [
    // Waits for its answer to be unwanted (the slice ending), never for a timer.
    { name: 'slow', handle: (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => (seen.slow.push('aborted'), resolve({ hookOutcome: { kind: 'observe' } })), { once: true })) },
    { name: 'fast', handle: (ctx) => ((seen.fast = ctx.signal.aborted), { hookOutcome: { kind: 'observe' } }) },
  ];
  await withDaemon({ subscribers, subscriberSliceMs: 100, limits: { budgetMs: { hot: 5000, background: 5000 } } }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const answer = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 5000, budget: 'hot', body: { deliveryKey: 'evt-slice-1', envelope: { kind: 'tool.finished' } } });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.result.results.slow, { queued: true });
    assert.deepEqual(seen.slow, ['aborted'], 'the slow subscriber saw its slice end before the answer went out');
    assert.equal(seen.fast, false, 'a subscriber answered within its slice sees a live signal');
  });
});

test('the client deadline is MAC-bound, must be an integer, can only shorten the budget, and a passed one answers DEADLINE (IPC-15)', { skip: managedHostSkip() }, async () => {
  const subscribers = [{ name: 'slow', handle: () => new Promise((resolve) => setTimeout(() => resolve('done'), 400)) }];
  await withDaemon({ subscribers, limits: { budgetMs: { hot: 300, background: 5000 } } }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const ws = registered.result.id;
    const session = await rawSession(home, 'hook');
    try {
      const body = (key) => ({ deliveryKey: key, envelope: { kind: 'PreToolUse' } });
      // Added after the MAC was computed: refused.
      const tampered = { ...session.frame('event', body('evt-mac'), { ws, budget: 'hot' }), deadlineAtMs: Date.now() + 60_000 };
      assert.equal((await session.send(tampered)).reasonCode, 'BAD_MAC');
    } finally {
      session.close();
    }
    const macFor = (s, op, text, extra) => protocol.requestMac(s.key, { snonce: s.snonce, id: extra.id, ws, op, ts: extra.ts, eventAtMs: null, budget: 'hot', body: text, deadlineAtMs: extra.deadlineAtMs });
    const signed = (s, key, deadlineAtMs) => {
      const id = protocol.newNonce();
      const ts = Date.now();
      const text = JSON.stringify({ deliveryKey: key, envelope: { kind: 'PreToolUse' } });
      return { t: 'req', v: 1, id, ws, op: 'event', ts, eventAtMs: null, budget: 'hot', body: text, deadlineAtMs, mac: macFor(s, 'event', text, { id, ts, deadlineAtMs }) };
    };
    const fractional = await rawSession(home, 'hook');
    try {
      assert.equal((await fractional.send(signed(fractional, 'evt-frac', Date.now() + 0.5))).reasonCode, 'MALFORMED');
    } finally {
      fractional.close();
    }
    const run = async (key, deadlineAtMs) => {
      const s = await rawSession(home, 'hook');
      try {
        return payload(await s.send(signed(s, key, deadlineAtMs)));
      } finally {
        s.close();
      }
    };
    // Far in the future: the 300 ms hot budget still bounds the wait, so the 400 ms subscriber is queued.
    const far = await run('evt-far', Date.now() + 60_000);
    assert.equal(far.ok, true, JSON.stringify(far));
    assert.deepEqual(far.body.queued, ['slow']);
    // Already passed: nothing runs.
    const passed = await run('evt-passed', Date.now() - 1_000);
    assert.equal(passed.ok, false);
    assert.equal(passed.reasonCode, 'DEADLINE');
  });
});

test('a subscriber with slow synchronous work runs after the answer, so the other proposals arrive in time, and returns once it is quick (IPC-15)', { skip: managedHostSkip() }, async () => {
  let blockMs = 150;
  const blockerRuns = [];
  const busy = (ms) => {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      // synchronous work: no timer can fire while this runs
    }
  };
  const subscribers = [
    {
      name: 'blocker',
      handle: () => {
        busy(blockMs);
        blockerRuns.push(blockMs);
        return { hookOutcome: { kind: 'context', text: 'blocker' } };
      },
    },
    { name: 'fast', handle: async () => ({ hookOutcome: { kind: 'context', text: 'fast' } }) },
  ];
  await withDaemon({ subscribers }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const event = (deliveryKey) =>
      sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 5_000, budget: 'hot', body: { deliveryKey, envelope: { kind: 'tool.finished' } } });
    // (A tool event: a restore or a Stop is never deferred, K3.)
    // First sight: nothing is known yet, so the blocker runs inline and is measured.
    const first = await event('evt-sync-1');
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.result.results.blocker, { hookOutcome: { kind: 'context', text: 'blocker' } });
    // Next event: the blocker is known to block, so it runs after the answer; fast still answers.
    const second = await event('evt-sync-2');
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.result.results.fast, { hookOutcome: { kind: 'context', text: 'fast' } });
    assert.deepEqual(second.result.results.blocker, { queued: true });
    assert.deepEqual(second.result.queued, ['blocker']);
    // It still runs, after the answer, and is measured again there.
    const settle = async (n) => {
      for (let i = 0; i < 100 && blockerRuns.length < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await settle(2);
    assert.deepEqual(blockerRuns, [150, 150]);
    blockMs = 0;
    const third = await event('evt-sync-3');
    assert.deepEqual(third.result.queued, ['blocker'], 'the last measurement was still slow');
    await settle(3);
    assert.deepEqual(blockerRuns, [150, 150, 0]);
    // Quick again: it is waited on inline once more.
    const fourth = await event('evt-sync-4');
    assert.equal(fourth.result.queued, undefined);
    assert.deepEqual(fourth.result.results.blocker, { hookOutcome: { kind: 'context', text: 'blocker' } });
  });
});

// ---------------------------------------------------------------- IPC-12: shared fallback socket directories

/** A socket file with no listener: a child binds it, then is killed so nothing unlinks it. */
function deadSocket(path) {
  const child = spawnSyncChild(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`], { stdio: 'ignore', timeout: 10_000 });
  assert.equal(child.signal, 'SIGKILL');
  assert.equal(statSync(path).isSocket(), true);
}

test('dead sockets left in a shared fallback directory are removed at start; live, young, foreign-named and non-socket entries are kept (IPC-12)', { skip: !posix }, async () => {
  const { chmodSync, symlinkSync } = await import('node:fs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b-fb-')));
  chmodSync(dir, 0o700);
  const live = await import('node:net').then(({ createServer }) => createServer());
  try {
    const name = (c) => join(dir, `${c.repeat(16)}.s`);
    deadSocket(name('a'));
    deadSocket(name('b'));
    deadSocket(join(dir, 'other.s'));
    await new Promise((resolve) => live.listen(name('c'), resolve));
    writeFileSync(name('d'), 'not a socket');
    symlinkSync(name('b'), name('e'));
    const later = Date.now() + 120_000;
    // Just created: too young to judge, so nothing goes.
    assert.equal(await sweepStaleFallbackSockets([dir]), 0);
    // An unsafe directory (group or other bits) is not swept at all.
    chmodSync(dir, 0o755);
    assert.equal(await sweepStaleFallbackSockets([dir], { nowMs: later }), 0);
    chmodSync(dir, 0o700);
    // Old enough: the two dead ones go, except the one this sidecar is using.
    assert.equal(await sweepStaleFallbackSockets([dir, dir], { nowMs: later, keep: name('b') }), 1);
    assert.equal(existsSync(name('a')), false);
    assert.equal(existsSync(name('b')), true, 'the kept path stays');
    assert.equal(statSync(name('c')).isSocket(), true, 'a live socket stays');
    assert.equal(readFileSync(name('d'), 'utf8'), 'not a socket');
    assert.equal(existsSync(join(dir, 'other.s')), true, 'a name that is not a fallback socket stays');
    assert.equal(existsSync(name('e')), true, 'a symlink is never followed or removed');
    assert.equal(await sweepStaleFallbackSockets([dir], { nowMs: later }), 1);
    assert.equal(existsSync(name('b')), false);
  } finally {
    await new Promise((resolve) => live.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the autostart wait is the product value, except that a test run may set it with JEVRIS_SIDECAR_WAIT_MS, clamped to 60 s; a hook never waits', () => {
  assert.equal(SIDECAR_TEST_WAIT_MAX_MS, 60_000);
  assert.equal(sidecarWaitMs(5000, {}), 5000, 'no override outside a test run');
  assert.equal(sidecarWaitMs(5000, { JEVRIS_SIDECAR_WAIT_MS: '60000' }), 5000, 'the variable alone does nothing in the product');
  assert.equal(sidecarWaitMs(5000, { JEVRIS_TEST: '1', JEVRIS_SIDECAR_WAIT_MS: '60000' }), 60_000);
  assert.equal(sidecarWaitMs(1500, { JEVRIS_TEST: '1', JEVRIS_SIDECAR_WAIT_MS: '999999999' }), 60_000, 'clamped');
  assert.equal(sidecarWaitMs(5000, { JEVRIS_TEST: '1', JEVRIS_SIDECAR_WAIT_MS: '2000' }), 2000);
  assert.equal(sidecarWaitMs(5000, { JEVRIS_TEST: '1', JEVRIS_SIDECAR_WAIT_MS: 'soon' }), 5000, 'a malformed value is ignored');
  assert.equal(sidecarWaitMs(0, { JEVRIS_TEST: '1', JEVRIS_SIDECAR_WAIT_MS: '60000' }), 0, 'a hook never blocks');
  assert.equal(sidecarWaitMs(-5, {}), 0);
});

// ---------------------------------------------------------------- concurrency audit P4, K1-K3 (owner ededdba)

test('a restore waits for its own session\'s capsule write, which ran past its deadline, and is never queued (K2, K3)', { skip: managedHostSkip() }, async () => {
  const written = new Set();
  const subscribers = [
    {
      name: 'orc',
      handle: async (ctx) => {
        const envelope = ctx.body.envelope;
        if (envelope.kind === 'context.compacting') {
          // Longer than 90% of the 2 s hot budget: even on the answer path the write runs on.
          await new Promise((resolve) => setTimeout(resolve, envelope.payload.slow === true ? 2100 : 300));
          written.add(envelope.sessionId);
          return { hookOutcome: { kind: 'observe' } };
        }
        if (envelope.kind === 'session.started') return { hookOutcome: { kind: 'context', text: written.has(envelope.sessionId) ? 'restored' : 'missing' } };
        return { hookOutcome: { kind: 'observe' } };
      },
    },
  ];
  // A roomy hot budget keeps the check about order, not about this machine's load.
  await withDaemon({ subscribers, subscriberSliceMs: 100, limits: { budgetMs: { hot: 2000, background: 5000 } } }, async ({ home, logs }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const envelope = (kind, sessionId, n, payload = {}) => ({ schemaVersion: '1.0', harness: 'claude', nativeEventName: kind, kind, sessionId, model: null, payload, dedupKey: `${kind}-${sessionId}-${n}` });
    const send = (kind, sessionId, n, payload) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 4000, budget: 'hot', body: { deliveryKey: `k-${kind}-${sessionId}-${n}`, envelope: envelope(kind, sessionId, n, payload) } });
    // PreCompact is an answer kind: a write longer than the 100 ms slice is still waited for.
    const quick = await send('context.compacting', 's0', 0);
    assert.equal(quick.result.queued, undefined, JSON.stringify(quick.result));
    assert.deepEqual(quick.result.results.orc, { hookOutcome: { kind: 'observe' } });
    // A capsule write past the deadline itself runs on, held by the executor for its session.
    const compact = await send('context.compacting', 's1', 1, { slow: true });
    assert.equal(compact.ok, true, JSON.stringify(compact));
    assert.deepEqual(compact.result.results.orc, { queued: true });
    // The restore right after it waits for that write, then answers with it: never queued.
    const restore = await send('session.started', 's1', 2);
    assert.equal(restore.ok, true, JSON.stringify(restore));
    assert.equal(restore.result.queued, undefined, JSON.stringify(restore.result) + JSON.stringify(logs.filter((l) => String(l.event).startsWith('trace:subscriber'))));
    assert.deepEqual(restore.result.results.orc, { hookOutcome: { kind: 'context', text: 'restored' } });
    // Another session is not held up by s1's work.
    const other = await send('session.started', 's2', 3);
    assert.deepEqual(other.result.results.orc, { hookOutcome: { kind: 'context', text: 'missing' } });
  });
});

test('a later tool event of a session with work still running queues behind it, in order (K2)', { skip: managedHostSkip() }, async () => {
  const order = [];
  const subscribers = [
    {
      name: 'orc',
      handle: async (ctx) => {
        const n = ctx.body.envelope.payload.n;
        if (n === 1) await new Promise((resolve) => setTimeout(resolve, 300));
        order.push(n);
        return { hookOutcome: { kind: 'observe' } };
      },
    },
  ];
  await withDaemon({ subscribers, subscriberSliceMs: 50 }, async ({ home, daemon }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    const send = (n) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 1500, budget: 'hot', body: { deliveryKey: `k-order-${n}`, envelope: { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'PostToolUse', kind: 'tool.finished', sessionId: 's1', model: null, payload: { n }, dedupKey: `order-${n}` } } });
    const first = await send(1);
    assert.deepEqual(first.result.results.orc, { queued: true });
    const second = await send(2);
    assert.deepEqual(second.result.results.orc, { queued: true }, 'it waits behind the first');
    for (let i = 0; i < 100 && order.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, [1, 2]);
    void daemon;
  });
});

test('a full hot pool answers BUSY at once while a background op is still admitted (P4)', { skip: managedHostSkip() }, async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const subscribers = [{ name: 'hold', handle: () => gate.then(() => ({ hookOutcome: { kind: 'observe' } })) }];
  await withDaemon({ subscribers, admission: { hot: 1, background: 1 }, limits: { budgetMs: { hot: 5000, background: 5000 } }, subscriberSliceMs: 4000 }, async ({ home }) => {
    const root = join(home, 'ws');
    mkdirSync(root);
    await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    const holding = sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 5000, budget: 'hot', body: { deliveryKey: 'k-hold', envelope: { kind: 'tool.finished' } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const began = Date.now();
    const refused = await sidecarRequest({ home, op: 'ping', scope: 'cli', timeoutMs: 3000, budget: 'hot', body: {} });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.reasonCode, 'BUSY');
    assert.ok(Date.now() - began < 2000, 'BUSY comes at once, not at the 3 s client deadline');
    const background = await sidecarRequest({ home, op: 'ping', scope: 'cli', timeoutMs: 3000, budget: 'background', body: {} });
    assert.equal(background.ok, true, JSON.stringify(background));
    release();
    assert.equal((await holding).ok, true);
  });
});

test('status shows the queue depth when the surface contract carries it, and always a valid body (P4)', async () => {
  const { surfacePayloadContract } = await import('@jevris/contracts');
  // Without the startup harness re-check: that job runs in the background executor after start,
  // and on a slow host it was still running (running: 1) when status asked (ubuntu, Node 22.14.0).
  await withDaemon({ liveCertification: false }, async ({ home }) => {
    const res = await sidecarRequest({ home, op: 'status', scope: 'mcp', body: {} });
    assert.equal(res.ok, true, JSON.stringify(res));
    const contract = surfacePayloadContract('status');
    assert.equal(contract.validate(res.result).ok, true);
    // An mcp-scoped request takes the background budget, so status counts itself there.
    const zero = { hotInFlight: 0, backgroundInFlight: 1, overrun: 0, running: 0, held: 0, queued: 0, spooled: 0 };
    const hasField = contract.validate({ ...res.result, queue: zero }).ok;
    assert.equal('queue' in res.result, hasField);
    if (hasField) assert.deepEqual(res.result.queue, zero, 'the status request itself is the one background request in flight');
  });
});
