import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { EXACT_BUDGET_LIMITS } from '../../../test/budget-scale.mjs';

// The answer lane (owner decision ededdba; D's K3 load test): a hook's SessionStart, Stop or
// PreCompact event is admitted from hot slots kept for it, so a full hot pool never answers it
// BUSY. The flag is in the request MAC, only a hook `event` may carry it, and the sidecar checks
// the envelope kind before anything runs.

const { startDaemon, sidecarRequest, runtimeFiles } = await import('../dist/index.js');
const protocol = await import('../dist/protocol.js');

function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'b-lane-')));
}

async function rawSession(home, kind) {
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
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  socket.on('close', () => {
    while (waiters.length > 0) waiters.shift()(null);
  });
  const next = () => new Promise((resolve) => (lines.length > 0 ? resolve(lines.shift()) : waiters.push(resolve)));
  const cnonce = protocol.newNonce();
  socket.write(`${JSON.stringify({ t: 'hello', v: 1, client: kind, cnonce })}\n`);
  const challenge = await next();
  assert.equal(challenge.t, 'challenge');
  const frame = (op, body, { priority = null, macPriority = priority, ws = '' } = {}) => {
    const id = protocol.newNonce();
    const ts = Date.now();
    const text = JSON.stringify(body);
    const mac = protocol.requestMac(key, { snonce: challenge.snonce, id, ws, op, ts, eventAtMs: null, budget: 'hot', body: text, priority: macPriority });
    return { t: 'req', v: 1, id, ws, op, ts, eventAtMs: null, budget: 'hot', body: text, ...(priority === null ? {} : { priority }), mac };
  };
  const send = async (value) => {
    socket.write(`${JSON.stringify(value)}\n`);
    return next();
  };
  return { frame, send, close: () => socket.destroy() };
}

const envelope = (kind, sessionId = 's1') => ({ schemaVersion: '1.0', kind, sessionId, harness: 'claude' });

test('requestPriority: only a hook event of an answer kind asks for the lane', () => {
  assert.equal(protocol.requestPriority('hook', 'event', { envelope: envelope('turn.stopped') }), 'answer');
  assert.equal(protocol.requestPriority('hook', 'event', { envelope: envelope('session.started') }), 'answer');
  assert.equal(protocol.requestPriority('hook', 'event', { envelope: envelope('context.compacting') }), 'answer');
  assert.equal(protocol.requestPriority('hook', 'event', { envelope: envelope('tool.finished') }), null);
  assert.equal(protocol.requestPriority('cli', 'event', { envelope: envelope('turn.stopped') }), null);
  assert.equal(protocol.requestPriority('hook', 'status', { envelope: envelope('turn.stopped') }), null);
  assert.equal(protocol.requestPriority('hook', 'event', null), null);
  const base = { snonce: 's', id: 'i', ws: '', op: 'event', ts: 1, eventAtMs: null, budget: 'hot', body: '{}', deadlineAtMs: 5 };
  const key = new Uint8Array(32);
  assert.notEqual(protocol.requestMac(key, { ...base, priority: 'answer' }), protocol.requestMac(key, base), 'the flag is in the MAC');
  assert.equal(protocol.requestMac(key, { ...base, priority: null }), protocol.requestMac(key, base), 'no flag, the MAC is unchanged');
});

test('with the hot pool full, a Stop is answered on the lane and an ordinary event is BUSY; a flag the MAC does not cover, from another client, or on another event is refused', { skip: managedHostSkip() }, async () => {
  const home = tempHome();
  const root = join(home, 'ws');
  mkdirSync(root);
  let releaseBlock;
  const blocked = new Promise((resolve) => (releaseBlock = resolve));
  let entered;
  const inside = new Promise((resolve) => (entered = resolve));
  const ops = [{ op: 'test.block', scope: 'status', budget: 'hot', workspace: 'optional', handle: async () => (entered(), await blocked, { ok: true, body: {} }) }];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, ops, admission: { hot: 1, answer: 2 }, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const holder = sidecarRequest({ home, op: 'test.block', scope: 'hook', timeoutMs: 10_000 });
    await inside;
    const event = (key, kind) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: key, envelope: envelope(kind) }, timeoutMs: 5_000 });
    const stop = await event('lane-1', 'turn.stopped');
    assert.equal(stop.ok, true, `a Stop is admitted on the answer lane: ${JSON.stringify(stop)}`);
    const tool = await event('lane-2', 'tool.finished');
    assert.equal(tool.ok, false);
    assert.equal(tool.reasonCode, 'BUSY', 'an ordinary event on a full hot pool is BUSY');

    // Each refusal closes its connection, so every case gets its own.
    const once = async (kind, op, body, options) => {
      const session = await rawSession(home, kind);
      try {
        return await session.send(session.frame(op, body, options));
      } finally {
        session.close();
      }
    };
    const stopBody = (key) => ({ deliveryKey: key, envelope: envelope('turn.stopped') });
    assert.equal((await once('hook', 'event', stopBody('lane-3'), { priority: 'answer', macPriority: null, ws: root })).reasonCode, 'BAD_MAC', 'a claimed lane the MAC does not cover');
    assert.equal((await once('hook', 'event', stopBody('lane-4'), { priority: 'urgent', ws: root })).reasonCode, 'MALFORMED');
    assert.equal((await once('hook', 'test.block', {}, { priority: 'answer' })).reasonCode, 'PRIORITY_REFUSED', 'only an event may ride the lane');
    assert.equal((await once('cli', 'event', stopBody('lane-5'), { priority: 'answer', ws: root })).reasonCode, 'PRIORITY_REFUSED', 'only a hook client may ask for the lane');
    // A lane request that is not an answer event: refused before anything runs.
    const wrongKind = await once('hook', 'event', { deliveryKey: 'lane-6', envelope: envelope('tool.finished') }, { priority: 'answer', ws: root });
    assert.equal(wrongKind.t, 'res', JSON.stringify(wrongKind));
    assert.equal(JSON.parse(wrongKind.payload).reasonCode, 'PRIORITY_REFUSED');

    releaseBlock();
    assert.equal((await holder).ok, true);
  } finally {
    releaseBlock();
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test('with every connection taken, a Stop still reaches the lane on a connection past the cap, and an ordinary event there reads BUSY', { skip: managedHostSkip() }, async () => {
  const home = tempHome();
  const root = join(home, 'ws');
  mkdirSync(root);
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, limits: { maxConnections: 2 }, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  const held = [];
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    // Two open, idle connections fill the served cap.
    held.push(await rawSession(home, 'hook'), await rawSession(home, 'hook'));
    const event = (key, kind) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: key, envelope: envelope(kind) }, timeoutMs: 5_000 });
    const stop = await event('cap-1', 'turn.stopped');
    assert.equal(stop.ok, true, `a Stop past the connection cap is served on the answer lane: ${JSON.stringify(stop)}`);
    const tool = await event('cap-2', 'tool.finished');
    assert.deepEqual([tool.ok, tool.reasonCode], [false, 'BUSY'], 'an ordinary event past the connection cap is BUSY');
  } finally {
    for (const session of held) session.close();
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test('an answer-lane event may use the hook deadline, not only the 900 ms hot budget, counted from the hook start; an ordinary event may not (ededdba, K3)', { skip: managedHostSkip() }, async () => {
  const home = tempHome();
  const root = join(home, 'ws');
  mkdirSync(root);
  // A subscriber that needs 300 ms, reached by an event whose hook started 800 ms earlier (a
  // loaded host's process start): inside the hot budget only 100 ms would be left.
  const slow = { name: 'slow-answer', handle: async () => (await new Promise((resolve) => setTimeout(resolve, 300)), { answered: true }) };
  // The subject is the budget: the product's exact 900 ms hot and 4 s answer-lane budgets, whatever scale the runner sets (test/budget-scale.mjs).
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, subscribers: [slow], limits: EXACT_BUDGET_LIMITS, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', workspace: root });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const event = (key, kind) => sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, body: { deliveryKey: key, envelope: envelope(kind, `s-${key}`) }, timeoutMs: 2_000, eventAtMs: Date.now() - 800, budget: 'hot' });
    const stop = await event('late-1', 'turn.stopped');
    assert.equal(stop.ok, true, JSON.stringify(stop));
    assert.deepEqual([stop.result.results['slow-answer'], stop.result.queued], [{ answered: true }, undefined], `a Stop answered in its slice: ${JSON.stringify(stop.result)}`);
    const tool = await event('late-2', 'tool.finished');
    const answered = tool.ok && tool.result.queued === undefined;
    assert.equal(answered, false, `an ordinary event keeps the 900 ms hot budget: ${JSON.stringify(tool)}`);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
