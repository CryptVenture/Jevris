import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createDeadline } = await import('@jevris/platform');
const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST } = provider;
const { JevClient, CircuitBreaker } = core;

const KEY = 'test-key-not-a-secret';
const tmp = () => mkdtempSync(join(tmpdir(), 'jevris-breaker-'));

test('PRV-07: background work retries 429 and 529 with Retry-After; the hot path makes one attempt', async () => {
  const sleeps = [];
  const fetch = createMockFetch({ scenario: ['http-429', 'http-529', 'valid'], retryAfterSeconds: 2 });
  const client = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch }), sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
  const result = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(60_000) });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [2000, 2000]);
  const hot = createMockFetch({ scenario: ['http-429', 'valid'] });
  const hotResult = await new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: hot }) }).ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(60_000) });
  assert.equal(hotResult.ok, false);
  assert.equal(hot.calls, 1);
});

test('PRV-07: a retry never outlives the deadline', async () => {
  const fetch = createMockFetch({ scenario: 'http-529', retryAfterSeconds: 30 });
  const client = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch }), sleep: async () => {} });
  const result = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(1000) });
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'overloaded');
  assert.equal(fetch.calls, 1);
});

test('PRV-07: 422 is repacked once and 401 disables the provider until the configuration changes (persisted)', async () => {
  const fetch422 = createMockFetch({ scenario: ['http-422', 'valid'] });
  let repacks = 0;
  const client422 = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: fetch422 }) });
  const repacked = await client422.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(5000), repack: () => { repacks += 1; return { ...CONFORMANCE_REQUEST, state: 'smaller packet' }; } });
  assert.equal(repacked.ok, true);
  assert.equal(repacks, 1);
  assert.equal(fetch422.calls, 2);
  const twice = createMockFetch({ scenario: 'http-422' });
  const again = await new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: twice }) }).ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(5000), repack: () => ({ ...CONFORMANCE_REQUEST, state: 'smaller' }) });
  assert.equal(again.ok, false);
  assert.equal(twice.calls, 2, 'the repacked request is sent once; a second 422 stops');

  const dir = tmp();
  try {
    const path = join(dir, 'circuit.json');
    const breaker = await CircuitBreaker.load(path);
    const fetch401 = createMockFetch({ scenario: 'http-401' });
    const client = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: fetch401 }), breaker, credentialFingerprint: 'fp-a', sleep: async () => {} });
    const first = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(5000) });
    assert.equal(first.failure, 'auth');
    assert.equal(fetch401.calls, 1, '401 is never retried');
    const restarted = await CircuitBreaker.load(path);
    assert.equal(restarted.snapshot('typesafe:primary', 'fp-a').state, 'disabled');
    const valid = createMockFetch();
    const sameKey = await new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: valid }), breaker: restarted, credentialFingerprint: 'fp-a' }).ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(5000) });
    assert.equal(sameKey.reasonCode, 'PROVIDER_DISABLED');
    assert.equal(valid.calls, 0);
    const newKey = await new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: valid }), breaker: restarted, credentialFingerprint: 'fp-b' }).ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(5000) });
    assert.equal(newKey.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PRV-08: the breaker opens after repeated failures, survives a restart, and a probe restores observation only', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'circuit.json');
    let now = 1_000_000;
    const options = { threshold: 3, cooldownMs: 10_000, restoreAfter: 2, now: () => now };
    const breaker = await CircuitBreaker.load(path, options);
    const failing = createMockFetch({ scenario: 'http-500' });
    const client = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: failing }), breaker });
    for (let i = 0; i < 3; i += 1) await client.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
    const open = await client.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
    assert.equal(open.reasonCode, 'CIRCUIT_OPEN');
    assert.equal(failing.calls, 3);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(file.entries['typesafe:primary'].state, 'open');

    const restarted = await CircuitBreaker.load(path, options);
    assert.equal(restarted.snapshot('typesafe:primary').state, 'open');
    now += 10_001;
    assert.equal(restarted.snapshot('typesafe:primary').state, 'half-open');
    const healthy = createMockFetch();
    const client2 = new JevClient({ transport: createSdkTransport({ apiKey: KEY, fetch: healthy }), breaker: restarted });
    const blocked = await client2.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
    assert.equal(blocked.reasonCode, 'CIRCUIT_OPEN', 'only a probe is admitted while half-open');
    const probe = await client2.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(2000), probe: true });
    assert.equal(probe.ok, true);
    assert.equal(probe.automation, false);
    const snap = restarted.snapshot('typesafe:primary');
    assert.equal(snap.state, 'observe-only');
    assert.equal(snap.automation, false);
    assert.equal(snap.observation, true);
    const automated = await client2.ask({ request: CONFORMANCE_REQUEST, lane: 'interactive', deadline: createDeadline(2000) });
    assert.equal(automated.reasonCode, 'OBSERVE_ONLY');
    for (let i = 0; i < 2; i += 1) {
      const observed = await client2.ask({ request: CONFORMANCE_REQUEST, lane: 'background', deadline: createDeadline(2000), observation: true });
      assert.equal(observed.ok, true);
    }
    assert.equal(restarted.snapshot('typesafe:primary').state, 'closed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PRV-08: a model change after an outage keeps automation off until an administrator resets it', async () => {
  let now = 0;
  const breaker = await CircuitBreaker.load(null, { threshold: 1, cooldownMs: 1, restoreAfter: 1, now: () => now });
  const key = 'typesafe:primary';
  breaker.recordSuccess(key, 'jev-1.13.0');
  breaker.recordFailure(key, 'overloaded', null);
  now = 5;
  assert.equal(breaker.admit(key, { observation: false, fingerprint: null, probe: true }).probeOnly, true);
  breaker.recordSuccess(key, 'jev-1.14.0', { probe: true });
  breaker.recordSuccess(key, 'jev-1.14.0');
  breaker.recordSuccess(key, 'jev-1.14.0');
  assert.equal(breaker.snapshot(key).state, 'observe-only');
  breaker.resetAutomation(key);
  assert.equal(breaker.snapshot(key).state, 'closed');
  assert.equal((await CircuitBreaker.load(null)).snapshot(key).state, 'closed');
});
