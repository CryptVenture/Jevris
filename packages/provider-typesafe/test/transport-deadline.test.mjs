import test from 'node:test';
import assert from 'node:assert/strict';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createDeadline } = await import('@jevris/platform');
const { createSdkTransport, createNativeReferenceTransport, createGatewayTransport, createMockFetch, CONFORMANCE_REQUEST } = provider;

const KEY = 'test-key-not-a-secret';
const TIMEOUT_MS = 200;
const CANCEL_AFTER_MS = 30;
const BUDGET_MS = 300;
// A hang guard, not a speed target (lint/wall-clock: at least 2 s). A transport that waits on a
// stalled body never returns at all; the outcome code and elapsedMs carry the deadline itself.
const MARGIN_MS = 2000;

const TRANSPORTS = [
  ['sdk', (fetch) => createSdkTransport({ apiKey: KEY, fetch })],
  ['native', (fetch) => createNativeReferenceTransport({ apiKey: KEY, fetch })],
];

/** Ends the test instead of hanging when a transport never settles. */
function bounded(promise, ms = TIMEOUT_MS + 5000) {
  let timer;
  return Promise.race([promise.finally(() => clearTimeout(timer)), new Promise((resolve) => (timer = setTimeout(() => resolve({ hung: true }), ms)))]);
}

/** Headers at once, then a body that stalls and ignores the abort signal. */
function stalledBodyFetch() {
  let started = 0;
  const fetch = async () => {
    started += 1;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"jev-1.13.0",'));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  Object.defineProperty(fetch, 'started', { get: () => started });
  return fetch;
}

/** Headers never arrive, and the abort signal is ignored. */
const deafFetch = () => new Promise(() => undefined);

for (const [name, make] of TRANSPORTS) {
  test(`PRV-05/PRV-06 (${name}): headers fast but the body stalls: the call ends at the deadline with DEADLINE`, async () => {
    const transport = make(stalledBodyFetch());
    const started = performance.now();
    const result = await bounded(transport.call(CONFORMANCE_REQUEST, { timeoutMs: TIMEOUT_MS }));
    const took = performance.now() - started;
    assert.notEqual(result.hung, true, 'the stalled body was awaited past the deadline');
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'timeout');
    assert.equal(result.sent, true, 'the request left, so it may be billed');
    assert.ok(took < TIMEOUT_MS + MARGIN_MS, `ended after ${Math.round(took)} ms`);
    assert.ok(result.elapsedMs >= TIMEOUT_MS - 5, `not before the deadline (${result.elapsedMs} ms)`);
    assert.ok(result.elapsedMs < TIMEOUT_MS + MARGIN_MS, `the transport's own elapsedMs (${result.elapsedMs} ms)`);
  });

  test(`PRV-05/PRV-06 (${name}): headers stall and fetch ignores the signal: the call ends at the deadline with DEADLINE`, async () => {
    const transport = make(deafFetch);
    const started = performance.now();
    const result = await bounded(transport.call(CONFORMANCE_REQUEST, { timeoutMs: TIMEOUT_MS }));
    const took = performance.now() - started;
    assert.notEqual(result.hung, true, 'the stalled headers were awaited past the deadline');
    assert.equal(result.failure, 'timeout');
    assert.equal(result.sent, true);
    assert.ok(took < TIMEOUT_MS + MARGIN_MS, `ended after ${Math.round(took)} ms`);
  });

  test(`PRV-05/PRV-06 (${name}): a caller abort while the body stalls is CANCELLED, not DEADLINE`, async () => {
    const transport = make(stalledBodyFetch());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CANCEL_AFTER_MS);
    const started = performance.now();
    const result = await bounded(transport.call(CONFORMANCE_REQUEST, { timeoutMs: 5000, signal: controller.signal }));
    clearTimeout(timer);
    const took = performance.now() - started;
    assert.notEqual(result.hung, true);
    assert.equal(result.failure, 'cancelled');
    assert.equal(result.sent, true);
    assert.ok(took < CANCEL_AFTER_MS + MARGIN_MS, `ended after ${Math.round(took)} ms`);
  });

  test(`PRV-05/PRV-06 (${name}): through the engine the stalled body is DEADLINE inside the decision budget`, async () => {
    const client = new core.JevClient({ transport: make(createMockFetch({ scenario: 'late-body' })) });
    const started = performance.now();
    const result = await bounded(client.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(BUDGET_MS) }));
    const took = performance.now() - started;
    assert.notEqual(result.hung, true);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'DEADLINE');
    assert.equal(result.failure, 'timeout');
    assert.ok(took < BUDGET_MS + MARGIN_MS, `ended after ${Math.round(took)} ms`);
  });

  test(`PRV-05/PRV-06 (${name}): a completed call leaves no deadline timer behind`, async () => {
    const transport = make(createMockFetch());
    const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
    const before = timers();
    const result = await transport.call(CONFORMANCE_REQUEST, { timeoutMs: 60_000 });
    assert.equal(result.ok, true);
    assert.ok(timers() <= before, `timers before ${before}, after ${timers()}`);
    const failed = await make(createMockFetch({ scenario: 'http-401' })).call(CONFORMANCE_REQUEST, { timeoutMs: 60_000 });
    assert.equal(failed.failure, 'auth');
    assert.ok(timers() <= before, 'a failed call clears its timer too');
  });
}

test('PRV-09: a gateway client that never answers is ended at the deadline; a caller abort is CANCELLED', async () => {
  const seen = [];
  const never = createGatewayTransport(
    'vercel',
    (request, options) => {
      seen.push(options);
      return new Promise(() => undefined);
    },
    { enabled: true },
  );
  const started = performance.now();
  const late = await bounded(never.call(CONFORMANCE_REQUEST, { timeoutMs: TIMEOUT_MS }));
  assert.notEqual(late.hung, true);
  assert.equal(late.failure, 'timeout');
  assert.equal(late.sent, true);
  assert.ok(performance.now() - started < TIMEOUT_MS + MARGIN_MS);
  assert.ok(seen[0].signal instanceof AbortSignal, 'the gateway client is handed the combined signal');
  assert.equal(seen[0].signal.aborted, true, 'and it fired at the deadline');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const cancelled = await bounded(never.call(CONFORMANCE_REQUEST, { timeoutMs: 5000, signal: controller.signal }));
  assert.equal(cancelled.failure, 'cancelled');
  const invalid = await never.call(CONFORMANCE_REQUEST, { timeoutMs: 0 });
  assert.equal(invalid.failure, 'deadline');
  assert.equal(invalid.sent, false);
});
