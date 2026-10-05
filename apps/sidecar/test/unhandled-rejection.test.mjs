// JEV-0068: a promise nobody handles used to end the sidecar on the spot (Node's default), with the error's text
// on stderr and the lock, endpoint and socket files left behind. The sidecar now logs the reason code (and an
// errno-shaped code, never a message or a stack), stops the way a signal stops it, and exits 70.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { UNHANDLED_REJECTION_EXIT_CODE, UNHANDLED_REJECTION_REASON, rejectionCode, runSidecarMain, sidecarRequest } = await import('../dist/index.js');

/** The listeners a running sidecar adds for unhandled rejections: only ours, so the test runner's own are never called. */
async function started(logs, onStart = () => undefined) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jvur-')));
  const before = process.listeners('unhandledRejection');
  const env = { ...process.env };
  delete env.JEVRIS_HOME;
  let exited = false;
  const running = runSidecarMain({ home, env, idleMs: 0, packageOps: false, store: false, log: (entry) => logs.push(entry), write: () => undefined }).finally(() => {
    exited = true;
  });
  let answer = await sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} });
  while (!answer.ok && !exited) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    answer = await sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} });
  }
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const added = process.listeners('unhandledRejection').filter((listener) => !before.includes(listener));
  if (added.length !== 1) {
    // Never leave a sidecar running behind a failed assertion: it would keep the test process alive.
    await sidecarRequest({ home, op: 'shutdown', scope: 'cli', body: {} });
    await running;
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(added.length, 1, 'a running sidecar installs one unhandled-rejection listener');
  onStart();
  return { home, running, listener: added[0], before };
}

test('an unhandled rejection stops the sidecar cleanly with its reason code logged, never the error text, and exits 70 (JEV-0068)', async () => {
  const logs = [];
  const { home, running, listener, before } = await started(logs);
  try {
    // Called directly, as Node would: the test runner's own listener is not asked, so the run is not failed by it.
    listener(Object.assign(new Error('FAKE-VENDOR-BODY /Users/someone/secret-project/key'), { code: 'ENOENT' }));
    const code = await running;
    assert.equal(code, UNHANDLED_REJECTION_EXIT_CODE);
    assert.equal(UNHANDLED_REJECTION_EXIT_CODE, 70);
    const fault = logs.find((entry) => entry.event === 'unhandled-rejection');
    assert.deepEqual({ level: fault?.level, reasonCode: fault?.reasonCode, code: fault?.code }, { level: 'error', reasonCode: 'UNHANDLED_REJECTION', code: 'ENOENT' });
    const stopping = logs.find((entry) => entry.event === 'stopping');
    assert.deepEqual({ level: stopping?.level, reason: stopping?.reason }, { level: 'error', reason: UNHANDLED_REJECTION_REASON });
    assert.ok(logs.some((entry) => entry.event === 'stopped' && entry.reason === UNHANDLED_REJECTION_REASON), 'it stopped fully, as a signal stops it');
    assert.ok(!JSON.stringify(logs).includes('FAKE-VENDOR-BODY') && !JSON.stringify(logs).includes('/Users/someone'), 'the log carries none of the error text');
    assert.deepEqual(process.listeners('unhandledRejection'), before, 'the listener is removed when the sidecar ends');
    assert.equal((await sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} })).ok, false, 'the sidecar is gone: its endpoint is removed, not left stale');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a rejection that carries no code is logged by its reason code alone (JEV-0068)', async () => {
  const logs = [];
  const { home, running, listener } = await started(logs);
  try {
    listener('a plain string rejection');
    assert.equal(await running, UNHANDLED_REJECTION_EXIT_CODE);
    const fault = logs.find((entry) => entry.event === 'unhandled-rejection');
    assert.equal(fault?.reasonCode, 'UNHANDLED_REJECTION');
    assert.equal(Object.hasOwn(fault ?? {}, 'code'), false);
    assert.ok(!JSON.stringify(logs).includes('plain string rejection'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a clean shutdown still exits 0 and leaves no unhandled-rejection listener behind (JEV-0068)', async () => {
  const logs = [];
  const { home, running, before } = await started(logs);
  try {
    await sidecarRequest({ home, op: 'shutdown', scope: 'cli', body: {} });
    assert.equal(await running, 0);
    assert.equal(logs.some((entry) => entry.event === 'unhandled-rejection'), false);
    assert.deepEqual(process.listeners('unhandledRejection'), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('rejectionCode keeps a system-shaped code and nothing else (JEV-0068)', () => {
  assert.equal(rejectionCode(Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'ECONNRESET');
  assert.equal(rejectionCode(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })), 'ERR_INVALID_ARG_TYPE');
  assert.equal(rejectionCode(Object.assign(new Error('x'), { code: 'rate limited: https://vendor.invalid/?token=FAKE' })), null);
  assert.equal(rejectionCode(Object.assign(new Error('x'), { code: 42 })), null);
  assert.equal(rejectionCode(new Error('x')), null);
  assert.equal(rejectionCode('ENOENT'), null);
  assert.equal(rejectionCode(null), null);
  assert.equal(rejectionCode(undefined), null);
});
